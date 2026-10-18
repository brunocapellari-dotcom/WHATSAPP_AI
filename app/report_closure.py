"""Orchestrate report calculation and durable closure without external side effects.

Caller supplies verified, historical observations and an explicit collector-health
signal. The engine is reconstructed from all historical observations for each
closure, preventing in-memory state from being mistaken for persisted history.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta

from .freight_reporting import (
    MT_TIMEZONE,
    REPORT_TIMES,
    FreightObservation,
    FreightReportEngine,
    FullReport,
    SimplifiedReport,
    report_slot,
    simplify,
    validate_slot,
)
from .report_repository import ReportSnapshotRepository


def calculate_closure(
    cutoff: datetime,
    observations: Iterable[FreightObservation],
    *,
    collector_healthy: bool,
    historical_health: Mapping[datetime, bool] | None = None,
) -> tuple[FullReport, SimplifiedReport]:
    cutoff = validate_slot(cutoff)
    engine = FreightReportEngine()
    # Replay all historical publication slots in order; processing only the
    # target slot would discard prior open offers and expiry state.
    history = list(observations)

    earliest = min((report_slot(o.published_at) for o in history
                    if report_slot(o.published_at) <= cutoff), default=cutoff)
    day = earliest.astimezone(MT_TIMEZONE).date()
    end_day = cutoff.astimezone(MT_TIMEZONE).date()
    if (end_day - day).days > 365:
        raise ValueError("historical replay exceeds one-year safety limit")
    slots = []
    while day <= end_day:
        for hour, minute in sorted(REPORT_TIMES):
            slot = datetime(day.year, day.month, day.day, hour, minute,
                            tzinfo=MT_TIMEZONE)
            if earliest <= slot <= cutoff:
                slots.append(slot)
        day += timedelta(days=1)
    full = None
    for slot in slots:
        # Do not retroactively apply the current health result to earlier
        # closures; doing so can incorrectly expire active freight offers.
        slot_healthy = (
            collector_healthy if slot == cutoff else
            historical_health.get(slot, False) if historical_health is not None else
            collector_healthy
        )
        full = engine.process(slot, history, collector_healthy=slot_healthy)
    if full is None:
        raise RuntimeError("closure generated no report slots")
    return full, simplify(full)


def persist_closure(
    repository: ReportSnapshotRepository,
    tenant_id: str,
    cutoff: datetime,
    observations: Iterable[FreightObservation],
    *,
    collector_healthy: bool,
    historical_health: Mapping[datetime, bool] | None = None,
) -> dict[str, bool]:
    full, simplified = calculate_closure(
        cutoff, observations, collector_healthy=collector_healthy,
        historical_health=historical_health,
    )
    # Persist the pair in one transaction before any delivery is queued.
    return repository.save_pair(
        tenant_id,
        full,
        simplified,
        collector_healthy=collector_healthy,
    )
