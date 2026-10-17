"""PostgreSQL-backed report snapshot repository.

No automatic publication. Each report is durable before delivery and tenant-scoped.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from datetime import datetime
from decimal import Decimal
from typing import Any

import psycopg

from .freight_reporting import (
    FullReport,
    SimplifiedReport,
    render_full_markdown,
    render_simplified_markdown,
    validate_slot,
)


def _json_default(value: Any) -> str:
    if isinstance(value, (datetime, Decimal)):
        return str(value)
    raise TypeError(f"unsupported report field: {type(value).__name__}")


def serialize_report(report: FullReport | SimplifiedReport) -> tuple[str, str, str]:
    kind = "FULL" if isinstance(report, FullReport) else "SIMPLIFIED"
    payload = json.dumps(asdict(report), ensure_ascii=False, sort_keys=True,
                         default=_json_default, separators=(",", ":"))
    markdown = (render_full_markdown(report) if kind == "FULL"
                else render_simplified_markdown(report))
    return kind, payload, markdown


class ReportSnapshotRepository:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    def save_ready(self, tenant_id: str, report: FullReport | SimplifiedReport,
                   *, collector_healthy: bool) -> bool:
        """Insert a report exactly once; return False for existing closure.

        Never silently overwrite a published snapshot with a different calculation.
        """
        if not tenant_id.strip():
            raise ValueError("tenant_id is required")
        cutoff = validate_slot(report.cutoff)
        kind, payload, markdown = serialize_report(report)
        digest = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
        status = "READY" if collector_healthy else "DRAFT"
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            cur.execute(
                """INSERT INTO whatsapp_freight_report_snapshots
                (tenant_id, cutoff_at, report_kind, status, payload, rendered_markdown,
                 content_sha256, collector_healthy)
                VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
                ON CONFLICT (tenant_id, cutoff_at, report_kind) DO NOTHING
                RETURNING report_kind""",
                (tenant_id, cutoff, kind, status, payload, markdown, digest, collector_healthy),
            )
            inserted = cur.fetchone() is not None
            conn.commit()
            return inserted

    def fetch(self, tenant_id: str, cutoff: datetime, kind: str) -> dict[str, Any] | None:
        validate_slot(cutoff)
        if kind not in {"FULL", "SIMPLIFIED"}:
            raise ValueError("invalid report kind")
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            cur.execute(
                """SELECT status, payload, rendered_markdown, content_sha256, collector_healthy
                   FROM whatsapp_freight_report_snapshots
                   WHERE tenant_id=%s AND cutoff_at=%s AND report_kind=%s""",
                (tenant_id, cutoff, kind),
            )
            row = cur.fetchone()
            return None if row is None else {
                "status": row[0], "payload": row[1], "markdown": row[2],
                "sha256": row[3], "collector_healthy": row[4],
            }
