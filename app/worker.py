from __future__ import annotations

import json
import sys

from app.integration import AgroLogClient, OutboxDispatcher
from app.storage import PostgresFreightStore


def main() -> int:
    store = PostgresFreightStore.from_env(worker=True)
    result = OutboxDispatcher(store, AgroLogClient.from_env()).flush()
    print(json.dumps(result, sort_keys=True))
    return 0 if result["failed"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
