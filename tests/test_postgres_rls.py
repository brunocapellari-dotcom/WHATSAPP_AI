from __future__ import annotations

import os
from datetime import UTC, datetime

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from app.models import FreightClassification, FreightEvent, RawInboundEvent
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
        }
    )
    assert apply_migrations(ADMIN_URL) == []

    with psycopg.connect(ADMIN_URL) as conn:
        with conn.cursor() as cur:
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


def _freight_event(tenant_id: str, source_id: str) -> FreightEvent:
    return FreightEvent(
        tenant_id=tenant_id,
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=[source_id],
        raw_reference=f"postgres://raw/{source_id}",
        timestamp=datetime(2026, 10, 7, 12, 0, tzinfo=UTC),
        product="SOJA",
        confidence=0.9,
    )


def test_rls_hides_rows_without_matching_tenant_session(
    database_roles: tuple[str, str],
) -> None:
    ingestor_url, _ = database_roles
    store = PostgresFreightStore(ingestor_url, RawCipher(b"0" * 32))
    store.save_raw("tenant-a", "fixture", _raw("rls-1"))

    with psycopg.connect(ingestor_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM whatsapp_raw_events")
            assert cur.fetchone()[0] == 0

            cur.execute("SELECT set_config('app.tenant_id', 'tenant-b', true)")
            cur.execute("SELECT count(*) FROM whatsapp_raw_events")
            assert cur.fetchone()[0] == 0

            cur.execute("SELECT set_config('app.tenant_id', 'tenant-a', true)")
            cur.execute("SELECT count(*) FROM whatsapp_raw_events")
            assert cur.fetchone()[0] == 1


def test_ingestor_cannot_write_another_tenant(
    database_roles: tuple[str, str],
) -> None:
    ingestor_url, _ = database_roles
    with psycopg.connect(ingestor_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', 'tenant-a', true)")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute(
                    """
                    INSERT INTO whatsapp_processed_source_events
                    (tenant_id, provider, source_event_id)
                    VALUES ('tenant-b', 'fixture', 'cross-tenant')
                    """
                )


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

    event_a = _freight_event("tenant-a", "source-a")
    event_b = _freight_event("tenant-b", "source-b")
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

    with psycopg.connect(worker_url, autocommit=True) as conn:
        with conn.cursor() as cur:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute("SELECT count(*) FROM whatsapp_raw_events")

    worker.mark_outbox_sent("tenant-b", outbox_id_a)
    remaining_a = worker.pending_outbox("tenant-a", limit=10)
    assert len(remaining_a) == 1
    assert remaining_a[0][0] == outbox_id_a

    worker.mark_outbox_sent("tenant-a", outbox_id_a)
    worker.mark_outbox_sent("tenant-b", outbox_id_b)
