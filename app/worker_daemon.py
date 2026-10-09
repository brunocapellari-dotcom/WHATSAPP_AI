from __future__ import annotations

import json
import os
import time

from app.integration import AgroLogClient, OutboxDispatcher
from app.storage import PostgresFreightStore


def main() -> int:
    tenant_id = os.environ.get("WHATSAPP_WORKER_TENANT_ID")
    if not tenant_id:
        raise RuntimeError("WHATSAPP_WORKER_TENANT_ID is required")
    interval = max(1, min(int(os.environ.get("WORKER_POLL_SECONDS", "5")), 60))

    store = PostgresFreightStore.from_env(worker=True)
    dispatcher = OutboxDispatcher(store, AgroLogClient.from_env(), tenant_id=tenant_id)

    while True:
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
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
