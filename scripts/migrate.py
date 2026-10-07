from __future__ import annotations

import hashlib
from pathlib import Path

import sqlparse

from app.database import DatabaseConnector

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def _statements(sql: str) -> list[str]:
    return [statement.strip() for statement in sqlparse.split(sql) if statement.strip()]


def apply_migrations(
    database: str | DatabaseConnector,
    migrations_dir: Path = MIGRATIONS_DIR,
) -> list[str]:
    applied: list[str] = []
    paths = sorted(migrations_dir.glob("*.sql"))
    if not paths:
        raise RuntimeError("no database migrations found")

    db = (
        database
        if isinstance(database, DatabaseConnector)
        else DatabaseConnector(database_url=database)
    )

    with db.connection(timeout_seconds=30) as conn:
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

                for statement in _statements(sql):
                    cur.execute(statement)
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
    db = DatabaseConnector.from_env("migrator")
    applied = apply_migrations(db)
    for version in applied:
        print(f"applied migration {version}")
    if not applied:
        print("database schema already current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
