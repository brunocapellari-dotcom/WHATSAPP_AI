from dataclasses import replace
from datetime import datetime
from decimal import Decimal

import pytest

from app.freight_reporting import (
    MT_TIMEZONE,
    FreightObservation,
    FreightReportEngine,
    render_full_markdown,
    render_simplified_markdown,
    report_slot,
    simplify,
)


def dt(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=MT_TIMEZONE)


def offer(source: str, carrier: str = "Rodoviva", rate: str = "173",
          *, published: datetime | None = None, city: str = "Sorriso",
          uf: str = "MT", loading_point: str = "Gaspar",
          dest: str = "Rondonópolis", dest_uf: str = "MT",
          product: str = "SOJA", cargo_ref: str | None = None,
          offer_ref: str | None = None, shipment_ref: str | None = None,
          rate_unit: str = "BRL/t") -> FreightObservation:
    return FreightObservation(
        source_observation_id=source, published_at=published or dt(15, 7),
        carrier=carrier, origin_city=city, origin_uf=uf,
        destination_city=dest, destination_uf=dest_uf,
        loading_point=loading_point, product=product, rate=Decimal(rate),
        rate_unit=rate_unit, cargo_reference=cargo_ref,
        offer_reference=offer_ref, shipment_reference=shipment_ref,
    )


def test_report_slots_are_half_open_and_evening_rolls_to_next_day() -> None:
    assert report_slot(dt(15, 0, 0)) == dt(15, 8, 30)
    assert report_slot(dt(15, 7, 59)) == dt(15, 8, 30)
    assert report_slot(dt(15, 8)) == dt(15, 14)
    assert report_slot(dt(15, 13, 29)) == dt(15, 14)
    assert report_slot(dt(15, 13, 30)) == dt(15, 17)
    assert report_slot(dt(15, 16, 29)) == dt(15, 17)
    assert report_slot(dt(15, 16, 30)) == dt(16, 8, 30)
    assert report_slot(dt(15, 23, 59)) == dt(16, 8, 30)


def test_twenty_carriers_are_twenty_offers_but_one_inferred_lot() -> None:
    engine = FreightReportEngine()
    observations = [offer(f"c-{i}", f"Carrier {i}", str(170 + i))
                    for i in range(20)]
    full = engine.process(dt(15, 8, 30), observations)
    simple = simplify(full)
    assert len(full.active_offers) == 20
    assert full.by_city_and_carrier[("Sorriso", "Carrier 0")] == 1
    assert simple.total_open_lots == 1
    assert simple.rows[0].commercial_offers == 20
    assert not simple.rows[0].cargo_confirmed
    assert simple.rows[0].rate_display == "R$ 170,00–189,00/t"
    assert simple.origin_totals == {"Sorriso": 1}
    assert simple.destination_totals == {"Rondonópolis/MT": 1}
    result = render_simplified_markdown(simple)
    assert "| Origem → Destino | Frete |" in result
    assert "| Origem → Destino | Frete | Lotes |" not in result
    assert "Totalizador por município de origem" in result
    assert "Totalizador por município de destino" in result


def test_only_mt_origins_and_independent_origin_destination_totals() -> None:
    engine = FreightReportEngine()
    full = engine.process(dt(15, 8, 30), [
        offer("a"),
        offer("b", carrier="Fibra Forte", loading_point="Vale Verde"),
        offer("c", carrier="Borgno", city="Sinop", dest="Santos", dest_uf="SP"),
        offer("d", carrier="Outside", city="Rio Verde", uf="GO"),
    ])
    assert len(full.active_offers) == 4
    simple = simplify(full)
    assert simple.total_open_lots == 3
    assert simple.origin_totals == {"Sinop": 1, "Sorriso": 2}
    assert simple.destination_totals == {"Rondonópolis/MT": 2, "Santos/SP": 1}
    assert sum(simple.origin_totals.values()) == simple.total_open_lots
    assert sum(simple.destination_totals.values()) == simple.total_open_lots


def test_two_confirmed_cargo_ids_do_not_collapse() -> None:
    engine = FreightReportEngine()
    full = engine.process(dt(15, 8, 30), [
        offer("a", cargo_ref="LOAD-A"),
        offer("b", cargo_ref="LOAD-B"),
    ])
    simple = simplify(full)
    assert simple.total_open_lots == 2
    assert all(row.cargo_confirmed for row in simple.rows)


def test_changed_carrier_does_not_change_competitor_price() -> None:
    engine = FreightReportEngine()
    engine.process(dt(15, 8, 30), [offer("a"), offer("b", "Fibra Forte", "178")])
    full = engine.process(dt(15, 14), [offer("c", rate="180", published=dt(15, 9))])
    assert len(full.active_offers) == 2
    assert full.new_offers == 0
    assert full.increases == 1 and full.decreases == 0
    assert full.movements[0].delta == Decimal("7")
    assert full.movements[0].percent == Decimal("4.05")
    prices = {o.carrier: o.rate for o in full.active_offers}
    assert prices == {"Rodoviva": 180, "Fibra Forte": 178}
    assert "Reajustes no intervalo" in render_full_markdown(full)


def test_price_can_change_several_times_but_keeps_one_offer() -> None:
    engine = FreightReportEngine()
    engine.process(dt(15, 8, 30), [offer("a")])
    full = engine.process(dt(15, 14), [
        offer("b", rate="177", published=dt(15, 9)),
        offer("c", rate="181", published=dt(15, 10, 40)),
        offer("d", rate="180", published=dt(15, 13, 5)),
    ])
    assert len(full.active_offers) == 1
    assert [m.delta for m in full.movements] == [4, 4, -1]
    assert full.active_offers[0].rate == 180
    assert simplify(full).total_open_lots == 1


def test_expire_after_three_healthy_consecutive_reports_and_reconfirm() -> None:
    engine = FreightReportEngine()
    engine.process(dt(15, 8, 30), [offer("a")])
    assert len(engine.process(dt(15, 14), []).active_offers) == 1
    assert len(engine.process(dt(15, 17), []).active_offers) == 1
    final = engine.process(dt(16, 8, 30), [])
    assert final.expired_offers == 1
    assert not final.active_offers


def test_republication_of_same_rate_restarts_absences_without_false_price_move() -> None:
    engine = FreightReportEngine()
    engine.process(dt(15, 8, 30), [offer("a")])
    engine.process(dt(15, 14), [])
    same = engine.process(dt(15, 17), [offer("b", published=dt(15, 16))])
    assert same.reconfirmed_offers == 1
    assert not same.movements
    assert len(engine.process(dt(16, 8, 30), []).active_offers) == 1
    assert len(engine.process(dt(16, 14), []).active_offers) == 1
    assert engine.process(dt(16, 17), []).expired_offers == 1


def test_unhealthy_collector_does_not_consume_absence() -> None:
    engine = FreightReportEngine()
    engine.process(dt(15, 8, 30), [offer("a")])
    engine.process(dt(15, 14), [], collector_healthy=False)
    engine.process(dt(15, 17), [])
    assert len(engine.process(dt(16, 8, 30), []).active_offers) == 1
    assert engine.process(dt(16, 14), []).expired_offers == 1


def test_duplicate_source_does_not_create_extra_lot() -> None:
    engine = FreightReportEngine()
    first = offer("same")
    full = engine.process(dt(15, 8, 30), [first, first])
    assert full.duplicate_source_events == 1
    assert len(full.active_offers) == 1


def test_evening_posts_only_in_next_morning_report() -> None:
    engine = FreightReportEngine()
    first = offer("evening", published=dt(15, 19))
    at_17 = engine.process(dt(15, 17), [first])
    assert len(at_17.active_offers) == 0
    at_morning = engine.process(dt(16, 8, 30), [first])
    assert at_morning.new_offers == 1
    assert len(at_morning.active_offers) == 1


def test_late_receipt_cannot_retroactively_modify_a_closed_report() -> None:
    engine = FreightReportEngine()
    delayed = replace(offer("later"), received_at=dt(15, 15))
    assert not engine.process(dt(15, 8, 30), [delayed]).active_offers
    assert len(engine.process(dt(15, 14), [delayed]).active_offers) == 0
    assert len(engine.process(dt(15, 17), [delayed]).active_offers) == 1


def test_invalid_cutoff_and_naive_timestamp_are_rejected() -> None:
    engine = FreightReportEngine()
    with pytest.raises(ValueError):
        engine.process(dt(15, 9), [])
    with pytest.raises(ValueError):
        offer("bad", published=datetime(2026, 10, 15, 9, 0))


def test_different_units_are_not_compared_as_one_price_band() -> None:
    engine = FreightReportEngine()
    full = engine.process(dt(15, 8, 30), [
        offer("a", "Rodoviva", "173", rate_unit="BRL/t"),
        offer("b", "Fibra Forte", "5500", rate_unit="BRL/carga"),
    ])
    simple = simplify(full)
    # One physical cargo; never sum prices with incompatible units.
    assert simple.total_open_lots == 1
    assert simple.rows[0].mixed_units
    assert "Unidades distintas" in simple.rows[0].rate_display
