from __future__ import annotations

import json
import os
import sys

from app.integration import AgroLogClient, OutboxDispatcher
from app.storage import PostgresFreightStore


def main() -> int:
    tenant_id = os.environ.get("WHATSAPP_WORKER_TENANT_ID")
    if not tenant_id:
        raise RuntimeError("WHATSAPP_WORKER_TENANT_ID is required")

    store = PostgresFreightStore.from_env(worker=True)
    before = store.outbox_status_counts(tenant_id)
    result = OutboxDispatcher(
        store,
        AgroLogClient.from_env(),
        tenant_id=tenant_id,
    ).flush()
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
        )
    )
    return 0 if result["failed"] == 0 and after["DEAD"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
