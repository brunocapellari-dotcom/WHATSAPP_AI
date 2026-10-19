from datetime import datetime
from decimal import Decimal

from app.freight_reporting import MT_TIMEZONE, FreightObservation
from app.report_closure import calculate_closure, persist_closure


def at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=MT_TIMEZONE)


def observation() -> FreightObservation:
    return FreightObservation(
        source_observation_id="report-1",
        published_at=at(15, 7),
        carrier="Carrier A",
        origin_city="Sorriso",
        origin_uf="MT",
        destination_city="Rondonópolis",
        destination_uf="MT",
        product="SOJA",
        loading_point="Fazenda X",
        rate=Decimal(180),
        rate_unit="BRL/t",
    )


def test_closure_replays_empty_slots_and_expires_absent_offers() -> None:
    full, simple = calculate_closure(
        at(15, 8, 30), [observation()], collector_healthy=True
    )
    assert len(full.active_offers) == 1
    assert simple.total_open_lots == 1
    later, later_simple = calculate_closure(
        at(16, 8, 30), [observation()], collector_healthy=True
    )
    assert len(later.active_offers) == 0
    assert later_simple.total_open_lots == 0


def test_unhealthy_collector_does_not_expire_existing_offers() -> None:
    full, _ = calculate_closure(
        at(16, 8, 30), [observation()], collector_healthy=False
    )
    assert len(full.active_offers) == 1


def test_persist_closure_writes_both_kinds() -> None:
    class Repo:
        def __init__(self):
            self.calls = []

        def save_pair(
            self,
            tenant_id,
            full,
            simplified,
            *,
            collector_healthy,
        ):
            self.calls.append(
                (
                    tenant_id,
                    type(full).__name__,
                    type(simplified).__name__,
                    collector_healthy,
                )
            )
            return {"FULL": True, "SIMPLIFIED": True}

    repo = Repo()
    assert persist_closure(
        repo,
        "tenant-a",
        at(15, 8, 30),
        [observation()],
        collector_healthy=True,
    ) == {"FULL": True, "SIMPLIFIED": True}
    assert repo.calls == [
        ("tenant-a", "FullReport", "SimplifiedReport", True)
    ]



def test_replay_preserves_historical_outage_without_premature_expiry() -> None:
    """Coverage gaps in prior slots must not count toward three absences."""
    history = {
        at(15, 8, 30): True,
        at(15, 14): False,
        at(15, 17): False,
        at(16, 8, 30): True,
    }
    report, simple = calculate_closure(
        at(16, 14), [observation()],
        collector_healthy=True,
        historical_health=history,
    )
    assert len(report.active_offers) == 1
    assert simple.total_open_lots == 1

    # Without outages, the 3 healthy missing confirmations expire the offer.
    report_no_outage, _ = calculate_closure(
        at(16, 14), [observation()],
        collector_healthy=True,
        historical_health={slot: True for slot in history},
    )
    assert len(report_no_outage.active_offers) == 0


def test_replay_with_missing_historical_coverage_freezes_absences() -> None:
    report, _ = calculate_closure(
        at(16, 14), [observation()],
        collector_healthy=True,
        historical_health={},
    )
    assert len(report.active_offers) == 1



def test_archival_backfill_does_not_enter_current_replay_or_break_one_year_limit() -> None:
    from dataclasses import replace

    # Publication years earlier but recovered today: it is searchable history,
    # not an active freight offer, nor a reason to run years of live closures.
    old = replace(
        observation(),
        published_at=datetime(2024, 10, 15, 7, tzinfo=MT_TIMEZONE),
        received_at=at(19, 7),
    )
    live = replace(
        observation(),
        source_observation_id="newer",
        published_at=at(19, 7),
        received_at=at(19, 7, 10),
    )
    full, simple = calculate_closure(
        at(19, 8, 30),
        [old, live],
        collector_healthy=True,
    )
    assert len(full.active_offers) == 1
    assert full.active_offers[0].source_observation_id == "newer"
    assert simple.total_open_lots == 1


def test_archival_only_backfill_yields_empty_current_report() -> None:
    from dataclasses import replace

    old = replace(
        observation(),
        published_at=datetime(2020, 10, 15, 7, tzinfo=MT_TIMEZONE),
        received_at=at(19, 7),
    )
    full, simple = calculate_closure(
        at(19, 8, 30),
        [old],
        collector_healthy=False,
    )
    assert full.active_offers == ()
    assert simple.total_open_lots == 0
