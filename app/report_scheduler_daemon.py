from __future__ import annotations

import json
import logging
import os
import time
from datetime import UTC, datetime

import psycopg

from .report_closure import persist_closure
from .report_delivery import ReportDeliveryQueue
from .report_observation_repository import ReportObservationRepository
from .report_operations import ReportOperationsRepository, probe_collector_health
from .report_repository import ReportSnapshotRepository
from .report_schedule import due_slots

logger = logging.getLogger("whatsapp_ai.report_scheduler")


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> int:
    database_url = _required("DATABASE_URL_REPORTER")
    tenant_id = _required("WHATSAPP_REPORT_TENANT_ID")
    health_urls = tuple(
        value.strip()
        for value in _required("REPORT_HEALTH_URLS").split(",")
        if value.strip()
    )
    if len(health_urls) != 2:
        raise RuntimeError("REPORT_HEALTH_URLS must contain bridge and provider URLs")
    allowed_hosts = {
        value.strip()
        for value in _required("REPORT_HEALTH_ALLOWED_HOSTS").split(",")
        if value.strip()
    }
    poll_seconds = max(10, min(int(os.environ.get("REPORT_POLL_SECONDS", "60")), 300))
    max_idle = int(os.environ.get("REPORT_MAX_COLLECTOR_IDLE_SECONDS", "14400"))
    tolerance = int(os.environ.get("REPORT_HEALTH_TOLERANCE_SECONDS", "600"))

    observations = ReportObservationRepository(database_url)
    snapshots = ReportSnapshotRepository(database_url)
    operations = ReportOperationsRepository(database_url)
    delivery = ReportDeliveryQueue(database_url)

    failures = 0
    while True:
        try:
            now = datetime.now(UTC)
            last_observation = observations.last_observation_at(tenant_id)
            health = probe_collector_health(
                urls=(health_urls[0], health_urls[1]),
                allowed_hosts=allowed_hosts,
                last_observation_at=last_observation,
                now=now,
                max_idle_seconds=max_idle,
            )
            operations.record_health(tenant_id, health)

            last_closed = snapshots.last_cutoff(tenant_id)
            for cutoff in due_slots(last_closed, now):
                cutoff_healthy = operations.health_near_cutoff(
                    tenant_id,
                    cutoff,
                    tolerance_seconds=tolerance,
                )
                run_id = operations.start_run(
                    tenant_id,
                    cutoff,
                    collector_healthy=cutoff_healthy,
                )
                try:
                    history = observations.load_through(tenant_id, cutoff)
                    persisted = persist_closure(
                        snapshots,
                        tenant_id,
                        cutoff,
                        history,
                        collector_healthy=cutoff_healthy,
                    )
                    queued = {"FULL": 0, "SIMPLIFIED": 0}
                    if cutoff_healthy:
                        queued = {
                            kind: delivery.queue_authorized(tenant_id, cutoff, kind)
                            for kind in ("FULL", "SIMPLIFIED")
                        }
                    operations.finish_run(
                        tenant_id,
                        run_id,
                        succeeded=True,
                    )
                    logger.info(
                        json.dumps(
                            {
                                "event": "report_closure_succeeded",
                                "tenant_id": tenant_id,
                                "cutoff": cutoff.isoformat(),
                                "collector_healthy": cutoff_healthy,
                                "observations": len(history),
                                "persisted": persisted,
                                "queued_deliveries": queued,
                            },
                            sort_keys=True,
                        )
                    )
                except Exception as exc:
                    operations.finish_run(
                        tenant_id,
                        run_id,
                        succeeded=False,
                        error_type=type(exc).__name__,
                    )
                    raise

            failures = 0
            time.sleep(poll_seconds)
        except (psycopg.Error, OSError, RuntimeError, ValueError) as exc:
            failures += 1
            delay = min(300, max(poll_seconds, 2 ** min(failures, 8)))
            logger.error(
                json.dumps(
                    {
                        "event": "report_scheduler_error",
                        "tenant_id": tenant_id,
                        "error_type": type(exc).__name__,
                        "consecutive_failures": failures,
                        "retry_in_seconds": delay,
                    },
                    sort_keys=True,
                )
            )
            time.sleep(delay)


if __name__ == "__main__":
    raise SystemExit(main())
