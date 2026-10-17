from __future__ import annotations

import os
from datetime import UTC, datetime

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from app.freight_reporting import FreightObservation
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
            "006_freight_report_snapshots.sql",
            "007_report_delivery_outbox.sql",
            "008_municipalities_and_report_observations.sql",
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
                IF NOT EXISTS (
                    SELECT 1 FROM pg_roles WHERE rolname='wa_test_reporter'
                ) THEN
                    CREATE ROLE wa_test_reporter LOGIN PASSWORD 'reporter-test-password';
                END IF;
            END
            $$;
            GRANT whatsapp_ingestor TO wa_test_ingestor;
            GRANT whatsapp_worker TO wa_test_worker;
            GRANT whatsapp_reporter TO wa_test_reporter;
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
            WHERE tenant_id='tenant-history'
            ORDER BY version
            """
        )
        assert cur.fetchall() == [(1, "170"), (2, "175")]

        cur.execute(
            """
            SELECT rate_previous, rate_current, rate_delta, rate_movement
            FROM whatsapp_freight_rate_changes
            WHERE tenant_id='tenant-history'
            """
        )
        assert cur.fetchall() == [(170, 175, 5, "AUMENTO")]

        cur.execute("SELECT set_config('app.tenant_id', 'other-tenant', true)")
        cur.execute("SELECT count(*) FROM whatsapp_freight_event_versions")
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM whatsapp_freight_rate_changes")
        assert cur.fetchone()[0] == 0



def test_ingestion_lock_reuses_one_database_session(
    database_roles: tuple[str, str],
) -> None:
    ingestor_url, _ = database_roles
    store = PostgresFreightStore(ingestor_url, RawCipher(b"4" * 32))
    with store.ingestion_lock("tenant-connection-reuse"):
        with store._connection() as first:
            first_pid = first.info.backend_pid
        with store._connection() as second:
            second_pid = second.info.backend_pid
        assert first_pid == second_pid



def test_canonical_municipality_resolution_and_reporter_rls(
    database_roles: tuple[str, str],
) -> None:
    assert ADMIN_URL is not None
    ingestor_url, _ = database_roles
    reporter_url = _role_dsn("wa_test_reporter", "reporter-test-password")

    with psycopg.connect(ADMIN_URL) as conn, conn.cursor() as cur:
        for code, name, uf in (
            (5107925, "Sorriso", "MT"),
            (5107602, "Rondonópolis", "MT"),
        ):
            normalized = (
                name.upper()
                .replace("Ó", "O")
                .replace("Ô", "O")
                .replace("Í", "I")
            )
            cur.execute(
                """
                INSERT INTO whatsapp_municipalities
                    (ibge_code, official_name, normalized_name, uf, source_url)
                VALUES (%s,%s,%s,%s,'fixture://ibge')
                ON CONFLICT (ibge_code) DO NOTHING
                """,
                (code, name, normalized, uf),
            )
            cur.execute(
                """
                INSERT INTO whatsapp_municipality_aliases
                    (alias_normalized, ibge_code, alias_kind)
                VALUES (%s,%s,'OFFICIAL')
                ON CONFLICT DO NOTHING
                """,
                (normalized, code),
            )
        conn.commit()

    store = PostgresFreightStore(ingestor_url, RawCipher(b"5" * 32))
    assert store.resolve_municipality("Sorriso/MT") == (
        "Sorriso",
        "MT",
        "5107925",
    )
    assert store.resolve_municipality("Rondonópolis - MT") == (
        "Rondonópolis",
        "MT",
        "5107602",
    )

    observation = FreightObservation(
        source_observation_id="postgres-report-1:line:1",
        source_event_id="postgres-report-1",
        source_line_number=1,
        published_at=datetime(2026, 10, 17, 7, 0, tzinfo=UTC),
        received_at=datetime(2026, 10, 17, 7, 1, tzinfo=UTC),
        carrier="Rodoviva",
        origin_city="Sorriso",
        origin_uf="MT",
        origin_ibge_code="5107925",
        destination_city="Rondonópolis",
        destination_uf="MT",
        destination_ibge_code="5107602",
        product="SOJA",
        loading_point="Fazenda A",
        rate=175,
        rate_unit="BRL/t",
        source_text_sha256="a" * 64,
        extraction_confidence=0.95,
    )
    store.save_observations_and_mark_source(
        "tenant-report",
        "fixture",
        "postgres-report-1",
        [observation],
    )

    with psycopg.connect(reporter_url) as conn, conn.cursor() as cur:
        cur.execute("SELECT set_config('app.tenant_id', 'tenant-report', true)")
        cur.execute(
            """
            SELECT origin_ibge_code, destination_ibge_code, rate
            FROM whatsapp_freight_observations
            """
        )
        assert cur.fetchall() == [(5107925, 5107602, 175)]

        cur.execute("SELECT set_config('app.tenant_id', 'other-tenant', true)")
        cur.execute("SELECT count(*) FROM whatsapp_freight_observations")
        assert cur.fetchone()[0] == 0
