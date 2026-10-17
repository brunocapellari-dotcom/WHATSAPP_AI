from __future__ import annotations

import json
import logging
import os
import time

import psycopg

from app.integration import AgroLogClient, OutboxDispatcher
from app.storage import PostgresFreightStore

logger = logging.getLogger("whatsapp_ai.worker")


def main() -> int:
    tenant_id = os.environ.get("WHATSAPP_WORKER_TENANT_ID")
    if not tenant_id:
        raise RuntimeError("WHATSAPP_WORKER_TENANT_ID is required")
    interval = max(1, min(int(os.environ.get("WORKER_POLL_SECONDS", "5")), 60))

    store = PostgresFreightStore.from_env(worker=True)
    dispatcher = OutboxDispatcher(store, AgroLogClient.from_env(), tenant_id=tenant_id)

    consecutive_failures = 0
    while True:
        try:
            before = store.outbox_status_counts(tenant_id)
            result = dispatcher.flush()
            after = store.outbox_status_counts(tenant_id)
            print(
                json.dumps(
                    {
                        "event": "outbox_dispatch",
                        "tenant_id": tenant_id,
                        "sent": result["sent"],
                        "failed": result["failed"],
                        "queue_before": before,
                        "queue_after": after,
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
            consecutive_failures = 0
            time.sleep(interval)
        except (psycopg.Error, OSError, RuntimeError, ValueError) as exc:
            consecutive_failures += 1
            delay = min(60, max(interval, 2 ** min(consecutive_failures, 6)))
            logger.error(
                json.dumps(
                    {
                        "event": "worker_loop_error",
                        "tenant_id": tenant_id,
                        "error_type": type(exc).__name__,
                        "consecutive_failures": consecutive_failures,
                        "retry_in_seconds": delay,
                    },
                    sort_keys=True,
                )
            )
            time.sleep(delay)


if __name__ == "__main__":
    raise SystemExit(main())
