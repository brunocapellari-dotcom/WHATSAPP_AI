"""Explicitly authorized report distribution queue.

This module does not send messages. Sending requires a separately audited
transport adapter and credentials; queueing is idempotent and tenant-scoped.
"""
from __future__ import annotations

from datetime import datetime

import psycopg

from .freight_reporting import validate_slot


class ReportDeliveryQueue:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    def queue_authorized(self, tenant_id: str, cutoff: datetime, kind: str) -> int:
        """Queue a READY, healthy report for recipients with explicit consent.

        Fail closed for unhealthy collectors, missing snapshots or revoked consent.
        A repeated call cannot duplicate deliveries.
        """
        if not tenant_id.strip():
            raise ValueError("tenant_id is required")
        cutoff = validate_slot(cutoff)
        if kind not in {"FULL", "SIMPLIFIED"}:
            raise ValueError("invalid report kind")
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            cur.execute(
                """INSERT INTO whatsapp_report_delivery_outbox
                    (tenant_id, cutoff_at, report_kind, recipient_id)
                   SELECT s.tenant_id, s.cutoff_at, s.report_kind, r.recipient_id
                   FROM whatsapp_freight_report_snapshots AS s
                   JOIN whatsapp_report_recipients AS r ON r.tenant_id=s.tenant_id
                   WHERE s.tenant_id=%s AND s.cutoff_at=%s AND s.report_kind=%s
                     AND s.status='READY' AND s.collector_healthy
                     AND r.authorized AND r.authorized_at IS NOT NULL
                   ON CONFLICT (tenant_id, cutoff_at, report_kind, recipient_id)
                   DO NOTHING
                   RETURNING delivery_id""",
                (tenant_id, cutoff, kind),
            )
            count = len(cur.fetchall())
            conn.commit()
            return count
