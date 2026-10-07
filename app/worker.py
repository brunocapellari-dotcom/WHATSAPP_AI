from __future__ import annotations

import json
import sys

from app.integration import AgroLogClient, OutboxDispatcher
from app.storage import PostgresFreightStore


def main() -> int:
    store = PostgresFreightStore.from_env(worker=True)
    before = store.outbox_status_counts()
    result = OutboxDispatcher(store, AgroLogClient.from_env()).flush()
    after = store.outbox_status_counts()
    print(
        json.dumps(
            {
                "event": "outbox_dispatch",
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
