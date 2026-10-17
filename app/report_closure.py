"""Orchestrate report calculation and durable closure without external side effects.

Caller supplies verified, historical observations and an explicit collector-health
signal. The engine is reconstructed from all historical observations for each
closure, preventing in-memory state from being mistaken for persisted history.
"""
from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

from .freight_reporting import (
    FreightObservation,
    FreightReportEngine,
    FullReport,
    SimplifiedReport,
    simplify,
    validate_slot,
)
from .report_repository import ReportSnapshotRepository


def calculate_closure(
    cutoff: datetime,
    observations: Iterable[FreightObservation],
    *,
    collector_healthy: bool,
) -> tuple[FullReport, SimplifiedReport]:
    cutoff = validate_slot(cutoff)
    engine = FreightReportEngine()
    # Replay all historical publication slots in order; processing only the
    # target slot would discard prior open offers and expiry state.
    from .freight_reporting import report_slot

    history = list(observations)
    slots = sorted({
        report_slot(o.published_at)
        for o in history
        if report_slot(o.published_at) <= cutoff
    } | {cutoff})
    if len(slots) > 10000:
        raise ValueError("historical replay exceeds safe closure limit")
    full = None
    for slot in slots:
        full = engine.process(slot, history, collector_healthy=collector_healthy)
    assert full is not None
    return full, simplify(full)


def persist_closure(
    repository: ReportSnapshotRepository,
    tenant_id: str,
    cutoff: datetime,
    observations: Iterable[FreightObservation],
    *,
    collector_healthy: bool,
) -> dict[str, bool]:
    full, simplified = calculate_closure(
        cutoff, observations, collector_healthy=collector_healthy
    )
    # Both snapshots must be saved before any downstream delivery queue runs.
    return {
        "FULL": repository.save_ready(
            tenant_id, full, collector_healthy=collector_healthy
        ),
        "SIMPLIFIED": repository.save_ready(
            tenant_id, simplified, collector_healthy=collector_healthy
        ),
    }
