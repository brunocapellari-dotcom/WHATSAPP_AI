from __future__ import annotations

import os
import re

import psycopg
from psycopg import sql

from scripts.migrate import apply_migrations

ROLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


def _runtime_role(name: str) -> str:
    value = os.environ.get(name, "")
    if not ROLE_RE.fullmatch(value):
        raise RuntimeError(f"{name} must be a valid PostgreSQL role name")
    return value


def main() -> int:
    database_url = os.environ.get("DATABASE_URL_MIGRATOR")
    if not database_url:
        raise RuntimeError("DATABASE_URL_MIGRATOR is required")

    ingest_role = _runtime_role("WHATSAPP_DB_INGEST_ROLE")
    worker_role = _runtime_role("WHATSAPP_DB_WORKER_ROLE")

    applied = apply_migrations(database_url)

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            for role in (ingest_role, worker_role):
                cur.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (role,))
                if cur.fetchone() is None:
                    raise RuntimeError(f"required PostgreSQL login role does not exist: {role}")

            cur.execute(
                sql.SQL("GRANT whatsapp_ingestor TO {}").format(
                    sql.Identifier(ingest_role)
                )
            )
            cur.execute(
                sql.SQL("GRANT whatsapp_worker TO {}").format(
                    sql.Identifier(worker_role)
                )
            )
            cur.execute(
                sql.SQL("REVOKE cloudsqlsuperuser FROM {}").format(
                    sql.Identifier(ingest_role)
                )
            )
            cur.execute(
                sql.SQL("REVOKE cloudsqlsuperuser FROM {}").format(
                    sql.Identifier(worker_role)
                )
            )
        conn.commit()

    print(
        "release migrations complete; "
        f"applied={len(applied)} runtime_role_grants=2"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
