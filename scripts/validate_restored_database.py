from __future__ import annotations

import hashlib
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"
REQUIRED_TABLES = {
    "whatsapp_schema_migrations",
    "whatsapp_raw_events",
    "whatsapp_freight_events",
    "whatsapp_processed_source_events",
    "whatsapp_agrolog_outbox",
}
RLS_TABLES = {
    "whatsapp_raw_events",
    "whatsapp_freight_events",
    "whatsapp_processed_source_events",
    "whatsapp_agrolog_outbox",
}


def restored_dsn(source_dsn: str, connection_name: str) -> str:
    if not connection_name or "/" in connection_name:
        raise RuntimeError("RESTORE_CONNECTION_NAME is invalid")
    parts = urlsplit(source_dsn)
    if parts.scheme not in {"postgres", "postgresql"}:
        raise RuntimeError("migrator DSN must use PostgreSQL")
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["host"] = f"/cloudsql/{connection_name}"
    query["sslmode"] = "disable"
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )


def expected_migrations() -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        result[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    if not result:
        raise RuntimeError("no migration files found in runtime image")
    return result


def main() -> int:
    source_dsn = os.environ.get("DATABASE_URL_SOURCE_MIGRATOR")
    connection_name = os.environ.get("RESTORE_CONNECTION_NAME")
    if not source_dsn or not connection_name:
        raise RuntimeError(
            "DATABASE_URL_SOURCE_MIGRATOR and RESTORE_CONNECTION_NAME are required"
        )

    expected = expected_migrations()
    dsn = restored_dsn(source_dsn, connection_name)

    with psycopg.connect(dsn, connect_timeout=10) as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema='public'
            """
        )
        tables = {str(row[0]) for row in cur.fetchall()}
        missing_tables = sorted(REQUIRED_TABLES - tables)
        if missing_tables:
            raise RuntimeError(f"restored database missing tables: {missing_tables}")

        cur.execute("SELECT version, checksum FROM whatsapp_schema_migrations")
        restored_migrations = {str(version): str(checksum) for version, checksum in cur.fetchall()}
        if restored_migrations != expected:
            missing = sorted(set(expected) - set(restored_migrations))
            extra = sorted(set(restored_migrations) - set(expected))
            mismatched = sorted(
                version
                for version in set(expected) & set(restored_migrations)
                if expected[version] != restored_migrations[version]
            )
            raise RuntimeError(
                "restored migration ledger mismatch: "
                f"missing={missing} extra={extra} mismatched={mismatched}"
            )

        cur.execute(
            """
            SELECT relname, relrowsecurity, relforcerowsecurity
            FROM pg_class
            WHERE relname = ANY(%s)
            """,
            (list(RLS_TABLES),),
        )
        rls = {
            str(name): (bool(enabled), bool(forced))
            for name, enabled, forced in cur.fetchall()
        }
        for table in RLS_TABLES:
            if rls.get(table) != (True, True):
                raise RuntimeError(f"RLS is not enabled+forced on restored table: {table}")

        cur.execute(
            """
            SELECT
              (SELECT count(*) FROM whatsapp_raw_events),
              (SELECT count(*) FROM whatsapp_freight_events),
              (SELECT count(*) FROM whatsapp_processed_source_events),
              (SELECT count(*) FROM whatsapp_agrolog_outbox)
            """
        )
        row = cur.fetchone()
        if row is None:
            raise RuntimeError("restored table count query returned no row")
        raw_count, freight_count, processed_count, outbox_count = row

    print(
        "RESTORE_VALIDATION_PASS "
        f"migrations={len(expected)} "
        f"raw_rows={int(raw_count)} "
        f"freight_rows={int(freight_count)} "
        f"processed_rows={int(processed_count)} "
        f"outbox_rows={int(outbox_count)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
