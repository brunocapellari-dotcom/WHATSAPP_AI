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
from .report_exports import full_xlsx, report_pdf, simplified_xlsx


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


def _artifacts(
    report: FullReport | SimplifiedReport,
) -> tuple[bytes, str, bytes, str]:
    pdf = report_pdf(report)
    xlsx = full_xlsx(report) if isinstance(report, FullReport) else simplified_xlsx(report)
    if not pdf.startswith(b"%PDF") or len(pdf) < 500:
        raise RuntimeError("generated PDF failed integrity validation")
    if not xlsx.startswith(b"PK") or len(xlsx) < 500:
        raise RuntimeError("generated XLSX failed integrity validation")
    return (
        pdf,
        hashlib.sha256(pdf).hexdigest(),
        xlsx,
        hashlib.sha256(xlsx).hexdigest(),
    )


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
        pdf, pdf_digest, xlsx, xlsx_digest = _artifacts(report)
        status = "READY" if collector_healthy else "DRAFT"
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            cur.execute(
                """
                SELECT content_sha256
                FROM whatsapp_freight_report_snapshots
                WHERE tenant_id=%s AND cutoff_at=%s AND report_kind=%s
                FOR UPDATE
                """,
                (tenant_id, cutoff, kind),
            )
            existing = cur.fetchone()
            if existing is not None:
                if existing[0] != digest:
                    raise RuntimeError(
                        f"immutable report conflict for {kind} at {cutoff.isoformat()}"
                    )
                return False
            cur.execute(
                """INSERT INTO whatsapp_freight_report_snapshots
                (tenant_id, cutoff_at, report_kind, status, payload, rendered_markdown,
                 content_sha256, pdf_data, pdf_sha256, xlsx_data, xlsx_sha256,
                 collector_healthy)
                VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    tenant_id,
                    cutoff,
                    kind,
                    status,
                    payload,
                    markdown,
                    digest,
                    pdf,
                    pdf_digest,
                    xlsx,
                    xlsx_digest,
                    collector_healthy,
                ),
            )
            conn.commit()
            return True

    def save_pair(
        self,
        tenant_id: str,
        full: FullReport,
        simplified: SimplifiedReport,
        *,
        collector_healthy: bool,
    ) -> dict[str, bool]:
        if full.cutoff != simplified.cutoff:
            raise ValueError("full and simplified report cutoffs must match")
        cutoff = validate_slot(full.cutoff)
        status = "READY" if collector_healthy else "DRAFT"
        snapshots = []
        for report in (full, simplified):
            kind, payload, markdown = serialize_report(report)
            digest = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
            pdf, pdf_digest, xlsx, xlsx_digest = _artifacts(report)
            snapshots.append(
                (
                    kind,
                    payload,
                    markdown,
                    digest,
                    pdf,
                    pdf_digest,
                    xlsx,
                    xlsx_digest,
                )
            )

        inserted: dict[str, bool] = {}
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            for (
                kind,
                payload,
                markdown,
                digest,
                pdf,
                pdf_digest,
                xlsx,
                xlsx_digest,
            ) in snapshots:
                cur.execute(
                    """
                    SELECT content_sha256
                    FROM whatsapp_freight_report_snapshots
                    WHERE tenant_id=%s AND cutoff_at=%s AND report_kind=%s
                    FOR UPDATE
                    """,
                    (tenant_id, cutoff, kind),
                )
                existing = cur.fetchone()
                if existing is not None:
                    if existing[0] != digest:
                        raise RuntimeError(
                            f"immutable report conflict for {kind} at {cutoff.isoformat()}"
                        )
                    inserted[kind] = False
                    continue
                cur.execute(
                    """
                    INSERT INTO whatsapp_freight_report_snapshots
                        (tenant_id, cutoff_at, report_kind, status, payload,
                         rendered_markdown, content_sha256, pdf_data, pdf_sha256,
                         xlsx_data, xlsx_sha256, collector_healthy)
                    VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        tenant_id,
                        cutoff,
                        kind,
                        status,
                        payload,
                        markdown,
                        digest,
                        pdf,
                        pdf_digest,
                        xlsx,
                        xlsx_digest,
                        collector_healthy,
                    ),
                )
                inserted[kind] = True
            conn.commit()
        return inserted

    def last_cutoff(self, tenant_id: str) -> datetime | None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            cur.execute(
                """
                SELECT max(cutoff_at)
                FROM whatsapp_freight_report_snapshots
                WHERE tenant_id=%s AND report_kind='FULL'
                """,
                (tenant_id,),
            )
            row = cur.fetchone()
        return None if row is None or row[0] is None else row[0]

    def fetch_artifacts(
        self,
        tenant_id: str,
        cutoff: datetime,
        kind: str,
    ) -> tuple[bytes, bytes] | None:
        validate_slot(cutoff)
        if kind not in {"FULL", "SIMPLIFIED"}:
            raise ValueError("invalid report kind")
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            cur.execute(
                """
                SELECT pdf_data, xlsx_data
                FROM whatsapp_freight_report_snapshots
                WHERE tenant_id=%s AND cutoff_at=%s AND report_kind=%s
                """,
                (tenant_id, cutoff, kind),
            )
            row = cur.fetchone()
        if row is None or row[0] is None or row[1] is None:
            return None
        return bytes(row[0]), bytes(row[1])

    def fetch(self, tenant_id: str, cutoff: datetime, kind: str) -> dict[str, Any] | None:
        validate_slot(cutoff)
        if kind not in {"FULL", "SIMPLIFIED"}:
            raise ValueError("invalid report kind")
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            cur.execute(
                """SELECT status, payload, rendered_markdown, content_sha256,
                          pdf_sha256, xlsx_sha256, collector_healthy
                   FROM whatsapp_freight_report_snapshots
                   WHERE tenant_id=%s AND cutoff_at=%s AND report_kind=%s""",
                (tenant_id, cutoff, kind),
            )
            row = cur.fetchone()
            return None if row is None else {
                "status": row[0],
                "payload": row[1],
                "markdown": row[2],
                "sha256": row[3],
                "pdf_sha256": row[4],
                "xlsx_sha256": row[5],
                "collector_healthy": row[6],
            }
