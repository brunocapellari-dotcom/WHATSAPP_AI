"""Real PostgreSQL/RLS smoke tests for durable WhatsApp report delivery parts."""
from __future__ import annotations

import hashlib
import os
from datetime import UTC, datetime
from uuid import uuid4

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from app.freight_reporting import MT_TIMEZONE
from app.report_delivery import ReportDeliveryQueue
from app.report_sender import ReportSendRepository
from scripts.migrate import apply_migrations

ADMIN_URL = os.environ.get("TEST_DATABASE_URL_ADMIN")
pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="PostgreSQL integration database not set")


@pytest.fixture(scope="module")
def reporter_url() -> str:
    assert ADMIN_URL is not None
    apply_migrations(ADMIN_URL)
    with psycopg.connect(ADMIN_URL) as conn, conn.cursor() as cur:
        cur.execute(
            """DO $$
               BEGIN
                 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wa_sender_ci') THEN
                   CREATE ROLE wa_sender_ci LOGIN PASSWORD 'ci-integration-password';
                 END IF;
               END $$;"""
        )
        cur.execute("GRANT whatsapp_reporter TO wa_sender_ci")
        conn.commit()
    info = conninfo_to_dict(ADMIN_URL)
    info["user"] = "wa_sender_ci"
    info["password"] = "ci-integration-password"
    return make_conninfo(**info)


def _setup(tenant_id: str) -> datetime:
    assert ADMIN_URL is not None
    cutoff = datetime(2026, 10, 18, 8, 30, tzinfo=MT_TIMEZONE)
    pdf = b"%PDF" + b"x" * 700
    xlsx = b"PK" + b"x" * 700
    with psycopg.connect(ADMIN_URL) as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO whatsapp_freight_report_snapshots
               (tenant_id, cutoff_at, report_kind, status, payload, rendered_markdown,
                collector_healthy, content_sha256,
                pdf_data, pdf_sha256, xlsx_data, xlsx_sha256)
               VALUES (%s,%s,'FULL','READY','{}'::jsonb,'Relatorio fretes',true,
                       %s,%s,%s,%s,%s)""",
            (
                tenant_id, cutoff, hashlib.sha256(b"Relatorio fretes").hexdigest(),
                pdf, hashlib.sha256(pdf).hexdigest(),
                xlsx, hashlib.sha256(xlsx).hexdigest(),
            ),
        )
        cur.execute(
            """INSERT INTO whatsapp_report_recipients
               (tenant_id, recipient_id, destination, transport, authorized, authorized_at)
               VALUES (%s,'recipient-a','5566999999999','WHATSAPP',true,now())""",
            (tenant_id,),
        )
        conn.commit()
    return cutoff


def test_parts_send_once_each_and_complete_only_after_last_ack(reporter_url: str) -> None:
    tenant = "dispatch-" + uuid4().hex
    cutoff = _setup(tenant)
    assert ReportDeliveryQueue(reporter_url).queue_authorized(tenant, cutoff, "FULL") == 1
    repo = ReportSendRepository(reporter_url, tenant)
    first = repo.claim_next()
    assert first is not None and first.part_kind == "TEXT"
    assert first.body == "Relatorio fretes"
    repo.conclude(first, message_id="provider-text-1")

    second = repo.claim_next()
    assert second is not None and second.part_kind == "PDF"
    assert isinstance(second.body, bytes) and second.body.startswith(b"%PDF")
    repo.conclude(second, message_id="provider-pdf-1")

    third = repo.claim_next()
    assert third is not None and third.part_kind == "XLSX"
    repo.conclude(third, message_id="provider-xlsx-1")
    assert repo.claim_next() is None

    with psycopg.connect(reporter_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        cur.execute(
            "SELECT status FROM whatsapp_report_delivery_outbox WHERE tenant_id=%s",
            (tenant,),
        )
        assert cur.fetchone() == ("SENT",)
        cur.execute(
            """SELECT part_kind, status FROM whatsapp_report_delivery_parts
               WHERE tenant_id=%s ORDER BY part_kind""",
            (tenant,),
        )
        assert cur.fetchall() == [
            ("PDF", "ACKNOWLEDGED"), ("TEXT", "ACKNOWLEDGED"), ("XLSX", "ACKNOWLEDGED")
        ]


def test_crash_or_uncertain_send_is_never_automatically_replayed(reporter_url: str) -> None:
    tenant = "crash-" + uuid4().hex
    cutoff = _setup(tenant)
    ReportDeliveryQueue(reporter_url).queue_authorized(tenant, cutoff, "FULL")
    repo = ReportSendRepository(reporter_url, tenant)
    first = repo.claim_next()
    assert first is not None
    # An unresolved external request must remain blocked even after restart.
    assert repo.claim_next() is None
    with psycopg.connect(reporter_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        cur.execute(
            """UPDATE whatsapp_report_delivery_parts
               SET claimed_at=now()-interval '10 minutes'
               WHERE tenant_id=%s AND delivery_id=%s AND part_kind='TEXT'""",
            (tenant, first.delivery_id),
        )
        conn.commit()
    assert repo.flag_expired_claims() == 1
    assert repo.claim_next() is None
    with psycopg.connect(reporter_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        cur.execute(
            "SELECT status FROM whatsapp_report_delivery_outbox WHERE tenant_id=%s",
            (tenant,),
        )
        assert cur.fetchone() == ("DEAD",)


def test_consent_revocation_blocks_pending_messages(reporter_url: str) -> None:
    tenant = "revoked-" + uuid4().hex
    cutoff = _setup(tenant)
    ReportDeliveryQueue(reporter_url).queue_authorized(tenant, cutoff, "FULL")
    assert ADMIN_URL is not None
    with psycopg.connect(ADMIN_URL) as conn, conn.cursor() as cur:
        cur.execute(
            "UPDATE whatsapp_report_recipients SET authorized=false WHERE tenant_id=%s",
            (tenant,),
        )
        conn.commit()
    repo = ReportSendRepository(reporter_url, tenant)
    assert repo.claim_next() is None
