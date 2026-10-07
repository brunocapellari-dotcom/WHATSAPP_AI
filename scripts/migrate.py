from __future__ import annotations

import hashlib
import os
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def apply_migrations(database_url: str, migrations_dir: Path = MIGRATIONS_DIR) -> list[str]:
    applied: list[str] = []
    paths = sorted(migrations_dir.glob("*.sql"))
    if not paths:
        raise RuntimeError("no database migrations found")

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS whatsapp_schema_migrations (
                    version text PRIMARY KEY,
                    checksum text NOT NULL,
                    applied_at timestamptz NOT NULL DEFAULT now()
                )
                """
            )
        conn.commit()

        for path in paths:
            sql = path.read_text(encoding="utf-8")
            checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
            version = path.name

            with conn.cursor() as cur:
                cur.execute(
                    "SELECT checksum FROM whatsapp_schema_migrations WHERE version=%s",
                    (version,),
                )
                row = cur.fetchone()
                if row:
                    if row[0] != checksum:
                        raise RuntimeError(f"migration checksum mismatch: {version}")
                    continue

                cur.execute(sql)
                cur.execute(
                    """
                    INSERT INTO whatsapp_schema_migrations (version, checksum)
                    VALUES (%s, %s)
                    """,
                    (version, checksum),
                )
            conn.commit()
            applied.append(version)

    return applied


def main() -> int:
    database_url = os.environ.get("DATABASE_URL_MIGRATOR")
    if not database_url:
        raise RuntimeError("DATABASE_URL_MIGRATOR is required")
    applied = apply_migrations(database_url)
    for version in applied:
        print(f"applied migration {version}")
    if not applied:
        print("database schema already current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
