from datetime import datetime
from decimal import Decimal

from app.freight_reporting import FreightObservation, MT_TIMEZONE
from app.report_closure import calculate_closure, persist_closure


def at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=MT_TIMEZONE)


def observation() -> FreightObservation:
    return FreightObservation(
        source_observation_id="report-1", published_at=at(15, 7),
        carrier="Carrier A", origin_city="Sorriso", origin_uf="MT",
        destination_city="Rondonópolis", destination_uf="MT",
        product="SOJA", loading_point="Fazenda X",
        rate=Decimal("180"), rate_unit="BRL/t",
    )


def test_closure_replays_empty_slots_and_expires_absent_offers() -> None:
    full, simple = calculate_closure(at(15, 8, 30), [observation()], collector_healthy=True)
    assert len(full.active_offers) == 1
    assert simple.total_open_lots == 1
    later, later_simple = calculate_closure(at(16, 8, 30), [observation()],
                                             collector_healthy=True)
    assert len(later.active_offers) == 0
    assert later_simple.total_open_lots == 0


def test_unhealthy_collector_does_not_expire_existing_offers() -> None:
    full, _ = calculate_closure(at(16, 8, 30), [observation()], collector_healthy=False)
    assert len(full.active_offers) == 1


def test_persist_closure_writes_both_kinds() -> None:
    class Repo:
        def __init__(self):
            self.calls = []

        def save_ready(self, tenant_id, report, *, collector_healthy):
            self.calls.append((tenant_id, type(report).__name__, collector_healthy))
            return True

    repo = Repo()
    assert persist_closure(repo, "tenant-a", at(15, 8, 30), [observation()],
                           collector_healthy=True) == {"FULL": True, "SIMPLIFIED": True}
    assert [kind for _, kind, _ in repo.calls] == ["FullReport", "SimplifiedReport"]
