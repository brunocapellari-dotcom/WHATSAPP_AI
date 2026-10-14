from __future__ import annotations

import os
from datetime import UTC, datetime

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from app.models import (
    FreightClassification,
    FreightEvent,
    RateChange,
    RateMovement,
    RawInboundEvent,
)
from app.storage import PostgresFreightStore, RawCipher
from scripts.migrate import apply_migrations

ADMIN_URL = os.environ.get("TEST_DATABASE_URL_ADMIN")

pytestmark = pytest.mark.skipif(
    not ADMIN_URL,
    reason="TEST_DATABASE_URL_ADMIN is required for PostgreSQL integration tests",
)


def _role_dsn(role: str, password: str) -> str:
    assert ADMIN_URL is not None
    params = conninfo_to_dict(ADMIN_URL)
    params["user"] = role
    params["password"] = password
    return make_conninfo(**params)


@pytest.fixture(scope="module")
def database_roles() -> tuple[str, str]:
    assert ADMIN_URL is not None
    applied = apply_migrations(ADMIN_URL)
    assert set(applied).issubset(
        {
            "001_core.sql",
            "002_rls.sql",
            "003_upgrade_existing.sql",
            "004_scope_worker_tenant.sql",
            "005_freight_event_history.sql",
            "006_rate_change_view_json_null.sql",
        }
    )
    assert apply_migrations(ADMIN_URL) == []

    with psycopg.connect(ADMIN_URL) as conn, conn.cursor() as cur:
        cur.execute(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_roles WHERE rolname='wa_test_ingestor'
                ) THEN
                    CREATE ROLE wa_test_ingestor LOGIN PASSWORD 'ingestor-test-password';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM pg_roles WHERE rolname='wa_test_worker'
                ) THEN
                    CREATE ROLE wa_test_worker LOGIN PASSWORD 'worker-test-password';
                END IF;
            END
            $$;
            GRANT whatsapp_ingestor TO wa_test_ingestor;
            GRANT whatsapp_worker TO wa_test_worker;
            """
        )
        conn.commit()

    return (
        _role_dsn("wa_test_ingestor", "ingestor-test-password"),
        _role_dsn("wa_test_worker", "worker-test-password"),
    )


def _raw(source_event_id: str) -> RawInboundEvent:
    return RawInboundEvent(
        source_event_id=source_event_id,
        source="rls-test",
        message_timestamp=datetime(2026, 10, 7, 12, 0, tzinfo=UTC),
        raw_text="FRETE SOJA ORIGEM: A DESTINO: B",
        raw_event={"fixture": True},
    )


def test_rls_hides_rows_without_matching_tenant_session(
    database_roles: tuple[str, str],
) -> None:
    ingestor_url, _ = database_roles
    store = PostgresFreightStore(ingestor_url, RawCipher(b"0" * 32))
    store.save_raw("tenant-a", "fixture", _raw("rls-1"))

    with psycopg.connect(ingestor_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM whatsapp_raw_events")
        assert cur.fetchone()[0] == 0

        cur.execute("SELECT set_config('app.tenant_id', 'tenant-b', true)")
        cur.execute("SELECT count(*) FROM whatsapp_raw_events")
        assert cur.fetchone()[0] == 0

        cur.execute("SELECT set_config('app.tenant_id', 'tenant-a', true)")
        cur.execute("SELECT count(*) FROM whatsapp_raw_events")
        assert cur.fetchone()[0] == 1


def test_worker_is_tenant_scoped_and_cannot_read_raw(
    database_roles: tuple[str, str],
) -> None:
    ingestor_url, worker_url = database_roles
    ingestor = PostgresFreightStore(ingestor_url, RawCipher(b"1" * 32))
    worker = PostgresFreightStore(
        worker_url,
        RawCipher(b"1" * 32),
        worker_mode=True,
    )

    event_a = FreightEvent(
        tenant_id="tenant-a",
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=["source-a"],
        raw_reference="postgres://raw/source-a",
        timestamp=datetime(2026, 10, 7, 12, 0, tzinfo=UTC),
        product="SOJA",
        confidence=0.9,
    )
    event_b = FreightEvent(
        tenant_id="tenant-b",
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=["source-b"],
        raw_reference="postgres://raw/source-b",
        timestamp=datetime(2026, 10, 7, 12, 0, tzinfo=UTC),
        product="MILHO",
        confidence=0.9,
    )
    ingestor.enqueue_outbox(event_a)
    ingestor.enqueue_outbox(event_b)

    pending_a = worker.pending_outbox("tenant-a", limit=10)
    assert len(pending_a) == 1
    outbox_id_a, pending_event_a = pending_a[0]
    assert pending_event_a.event_id == event_a.event_id

    pending_b = worker.pending_outbox("tenant-b", limit=10)
    assert len(pending_b) == 1
    outbox_id_b, pending_event_b = pending_b[0]
    assert pending_event_b.event_id == event_b.event_id

    with (
        psycopg.connect(worker_url, autocommit=True) as conn,
        conn.cursor() as cur,
        pytest.raises(psycopg.errors.InsufficientPrivilege),
    ):
        cur.execute("SELECT count(*) FROM whatsapp_raw_events")

    counts_a = worker.outbox_status_counts("tenant-a")
    counts_b = worker.outbox_status_counts("tenant-b")
    assert counts_a["PROCESSING"] == 1
    assert counts_b["PROCESSING"] == 1

    worker.mark_outbox_sent("tenant-b", outbox_id_a)
    assert worker.outbox_status_counts("tenant-a")["PROCESSING"] == 1

    worker.mark_outbox_sent("tenant-a", outbox_id_a)
    worker.mark_outbox_sent("tenant-b", outbox_id_b)
    assert worker.outbox_status_counts("tenant-a")["SENT"] >= 1
    assert worker.outbox_status_counts("tenant-b")["SENT"] >= 1


def test_ingress_readiness_uses_rls_scoped_table_access(
    database_roles: tuple[str, str],
) -> None:
    ingestor_url, _ = database_roles
    store = PostgresFreightStore(ingestor_url, RawCipher(b"2" * 32))
    store.readiness_check()



def test_freight_version_history_is_immutable_and_tenant_scoped(
    database_roles: tuple[str, str],
) -> None:
    ingestor_url, _ = database_roles
    store = PostgresFreightStore(ingestor_url, RawCipher(b"3" * 32))
    event = FreightEvent(
        tenant_id="tenant-history",
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=["history-1"],
        raw_reference="postgres://raw/history-1",
        timestamp=datetime(2026, 10, 13, 7, 0, tzinfo=UTC),
        product="SOJA",
        rate=170,
        rate_unit="BRL/t",
        confidence=0.9,
    )
    store.save_event(event, "logical-history")
    event.version = 2
    event.classification = FreightClassification.UPDATE
    event.rate = 175
    event.timestamp = datetime(2026, 10, 13, 9, 0, tzinfo=UTC)
    event.rate_change = RateChange(
        previous_rate=170,
        current_rate=175,
        delta=5,
        delta_percent="2.94",
        movement=RateMovement.INCREASE,
        previous_timestamp=datetime(2026, 10, 13, 7, 0, tzinfo=UTC),
        changed_at=datetime(2026, 10, 13, 9, 0, tzinfo=UTC),
    )
    event.source_event_ids.append("history-2")
    store.save_event(event, "logical-history")

    with psycopg.connect(ingestor_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT set_config('app.tenant_id', 'tenant-history', true)")
        cur.execute(
            """
            SELECT version, payload->>'rate'
            FROM whatsapp_freight_event_versions
            WHERE tenant_id='tenant-history' AND event_id=%s
            ORDER BY version
            """,
            (event.event_id,),
        )
        assert cur.fetchall() == [(1, "170"), (2, "175")]

        cur.execute(
            """
            SELECT rate_previous, rate_current, rate_delta, rate_movement
            FROM whatsapp_freight_rate_changes
            WHERE tenant_id='tenant-history' AND event_id=%s
            """,
            (event.event_id,),
        )
        assert cur.fetchall() == [(170, 175, 5, "AUMENTO")]

        cur.execute("SELECT set_config('app.tenant_id', 'other-tenant', true)")
        cur.execute("SELECT count(*) FROM whatsapp_freight_event_versions")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM whatsapp_freight_rate_changes")
        assert cur.fetchone()[0] == 0
