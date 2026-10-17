from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import psycopg


@dataclass(frozen=True)
class CollectorHealth:
    sampled_at: datetime
    healthy: bool
    bridge_ok: bool
    provider_ok: bool
    last_observation_at: datetime | None
    reason: str | None


def probe_collector_health(
    *,
    urls: tuple[str, str],
    allowed_hosts: set[str],
    last_observation_at: datetime | None,
    now: datetime,
    max_idle_seconds: int,
) -> CollectorHealth:
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("health sample time must be timezone-aware")
    if not 300 <= max_idle_seconds <= 86_400:
        raise ValueError("max_idle_seconds must be between 300 and 86400")

    statuses: list[bool] = []
    for url in urls:
        parsed = urlparse(url)
        if parsed.scheme != "http" or parsed.hostname not in allowed_hosts:
            raise ValueError("collector health URL is not an approved private HTTP target")
        try:
            response = httpx.get(url, timeout=3.0)
            statuses.append(response.status_code == 200)
        except httpx.HTTPError:
            statuses.append(False)

    bridge_ok, provider_ok = statuses
    if last_observation_at is None:
        fresh = False
    else:
        if last_observation_at.tzinfo is None or last_observation_at.utcoffset() is None:
            raise ValueError("last observation time must be timezone-aware")
        age = (now - last_observation_at).total_seconds()
        fresh = 0 <= age <= max_idle_seconds

    healthy = bridge_ok and provider_ok and fresh
    reasons = []
    if not bridge_ok:
        reasons.append("bridge_unhealthy")
    if not provider_ok:
        reasons.append("provider_unhealthy")
    if not fresh:
        reasons.append("observation_stale_or_missing")
    return CollectorHealth(
        sampled_at=now,
        healthy=healthy,
        bridge_ok=bridge_ok,
        provider_ok=provider_ok,
        last_observation_at=last_observation_at,
        reason=",".join(reasons) if reasons else None,
    )


class ReportOperationsRepository:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    @staticmethod
    def _set_tenant(cur, tenant_id: str) -> None:
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))

    def record_health(self, tenant_id: str, sample: CollectorHealth) -> None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                INSERT INTO whatsapp_collector_health_samples
                    (tenant_id, sampled_at, healthy, bridge_ok, provider_ok,
                     last_observation_at, reason)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (tenant_id, sampled_at) DO NOTHING
                """,
                (
                    tenant_id,
                    sample.sampled_at,
                    sample.healthy,
                    sample.bridge_ok,
                    sample.provider_ok,
                    sample.last_observation_at,
                    sample.reason,
                ),
            )
            conn.commit()

    def health_near_cutoff(
        self,
        tenant_id: str,
        cutoff: datetime,
        *,
        tolerance_seconds: int,
    ) -> bool:
        if not 60 <= tolerance_seconds <= 3600:
            raise ValueError("health tolerance must be between 60 and 3600 seconds")
        lower = cutoff - timedelta(seconds=tolerance_seconds)
        upper = cutoff + timedelta(seconds=tolerance_seconds)
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                SELECT healthy
                FROM whatsapp_collector_health_samples
                WHERE tenant_id=%s AND sampled_at BETWEEN %s AND %s
                ORDER BY abs(extract(epoch FROM sampled_at - %s))
                LIMIT 1
                """,
                (tenant_id, lower, upper, cutoff),
            )
            row = cur.fetchone()
        return bool(row[0]) if row is not None else False

    def start_run(
        self,
        tenant_id: str,
        cutoff: datetime,
        *,
        collector_healthy: bool,
    ) -> str:
        run_id = str(uuid4())
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                INSERT INTO whatsapp_report_runs
                    (tenant_id, run_id, cutoff_at, status, collector_healthy)
                VALUES (%s,%s,%s,'STARTED',%s)
                """,
                (tenant_id, run_id, cutoff, collector_healthy),
            )
            conn.commit()
        return run_id

    def finish_run(
        self,
        tenant_id: str,
        run_id: str,
        *,
        succeeded: bool,
        error_type: str | None = None,
    ) -> None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                UPDATE whatsapp_report_runs
                SET status=%s, finished_at=now(), error_type=%s
                WHERE tenant_id=%s AND run_id=%s AND status='STARTED'
                """,
                (
                    "SUCCEEDED" if succeeded else "FAILED",
                    error_type,
                    tenant_id,
                    run_id,
                ),
            )
            conn.commit()
