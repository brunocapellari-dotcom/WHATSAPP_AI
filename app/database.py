from __future__ import annotations

import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator, Literal

import psycopg

DatabaseRole = Literal["ingress", "worker", "migrator"]


@dataclass
class DatabaseConnector:
    """Open PostgreSQL connections without embedding production DB passwords.

    Local/CI may provide a DATABASE_URL*. Production prefers Cloud SQL Python
    Connector with automatic IAM database authentication.
    """

    database_url: str | None = None
    instance_connection_name: str | None = None
    database_name: str | None = None
    iam_user: str | None = None
    ip_type: str = "PUBLIC"
    _cloud_connector: Any = None

    @classmethod
    def from_env(cls, role: DatabaseRole) -> "DatabaseConnector":
        local_env = {
            "ingress": "DATABASE_URL",
            "worker": "DATABASE_URL_WORKER",
            "migrator": "DATABASE_URL_MIGRATOR",
        }[role]
        database_url = os.environ.get(local_env)
        if database_url:
            return cls(database_url=database_url)

        instance = os.environ.get("CLOUD_SQL_INSTANCE_CONNECTION_NAME")
        database = os.environ.get("CLOUD_SQL_DATABASE")
        iam_user = os.environ.get("CLOUD_SQL_IAM_USER")
        ip_type = os.environ.get("CLOUD_SQL_IP_TYPE", "PUBLIC").upper()

        missing = [
            name
            for name, value in {
                "CLOUD_SQL_INSTANCE_CONNECTION_NAME": instance,
                "CLOUD_SQL_DATABASE": database,
                "CLOUD_SQL_IAM_USER": iam_user,
            }.items()
            if not value
        ]
        if missing:
            raise RuntimeError(
                f"{local_env} is absent and Cloud SQL IAM config is incomplete: "
                + ", ".join(missing)
            )
        if ip_type not in {"PUBLIC", "PRIVATE", "PSC"}:
            raise RuntimeError("CLOUD_SQL_IP_TYPE must be PUBLIC, PRIVATE or PSC")

        return cls(
            instance_connection_name=instance,
            database_name=database,
            iam_user=iam_user,
            ip_type=ip_type,
        )

    def _get_cloud_connector(self, timeout_seconds: int):
        if self._cloud_connector is None:
            from google.cloud.sql.connector import Connector

            self._cloud_connector = Connector(
                refresh_strategy="LAZY",
                enable_iam_auth=True,
                timeout=timeout_seconds,
                ip_type=self.ip_type,
            )
        return self._cloud_connector

    @contextmanager
    def connection(self, timeout_seconds: int = 5) -> Iterator[Any]:
        if self.database_url:
            with psycopg.connect(
                self.database_url,
                connect_timeout=timeout_seconds,
            ) as conn:
                yield conn
            return

        if not (
            self.instance_connection_name
            and self.database_name
            and self.iam_user
        ):
            raise RuntimeError("database connector is not configured")

        import pg8000.dbapi

        pg8000.dbapi.paramstyle = "format"
        connector = self._get_cloud_connector(timeout_seconds)
        conn = connector.connect(
            self.instance_connection_name,
            "pg8000",
            user=self.iam_user,
            db=self.database_name,
            enable_iam_auth=True,
            ip_type=self.ip_type,
        )
        try:
            yield conn
        finally:
            conn.close()

    def close(self) -> None:
        if self._cloud_connector is not None:
            self._cloud_connector.close()
            self._cloud_connector = None
