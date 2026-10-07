from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from typing import Protocol

import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .models import FreightEvent, RawInboundEvent
from .security import sha256_hex


class FreightStore(Protocol):
    def save_raw(self, tenant_id: str, provider: str, event: RawInboundEvent) -> str: ...
    def has_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> bool: ...
    def mark_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> None: ...
    def find_logical_event(self, tenant_id: str, logical_key: str) -> FreightEvent | None: ...
    def save_event(self, event: FreightEvent, logical_key: str) -> None: ...
    def enqueue_outbox(self, event: FreightEvent) -> None: ...
    def pending_outbox(self, limit: int = 100) -> list[tuple[int, FreightEvent]]: ...
    def mark_outbox_sent(self, outbox_id: int) -> None: ...
    def mark_outbox_failed(self, outbox_id: int, error: str) -> None: ...


class InMemoryFreightStore:
    """Test-only store. Production must use PostgresFreightStore."""

    def __init__(self) -> None:
        self.raw: list[dict] = []
        self.source_ids: set[tuple[str, str, str]] = set()
        self.events: dict[tuple[str, str], FreightEvent] = {}
        self.outbox: list[FreightEvent] = []

    def save_raw(self, tenant_id: str, provider: str, event: RawInboundEvent) -> str:
        ref = f"memory://raw/{tenant_id}/{provider}/{event.source_event_id}"
        self.raw.append({"ref": ref, "event": event.model_dump(mode="json")})
        return ref

    def has_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> bool:
        return (tenant_id, provider, source_event_id) in self.source_ids

    def mark_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> None:
        self.source_ids.add((tenant_id, provider, source_event_id))

    def find_logical_event(self, tenant_id: str, logical_key: str) -> FreightEvent | None:
        return self.events.get((tenant_id, logical_key))

    def save_event(self, event: FreightEvent, logical_key: str) -> None:
        self.events[(event.tenant_id, logical_key)] = event

    def enqueue_outbox(self, event: FreightEvent) -> None:
        if not any(e.event_id == event.event_id and e.version == event.version for e in self.outbox):
            self.outbox.append(event)

    def pending_outbox(self, limit: int = 100) -> list[tuple[int, FreightEvent]]:
        return list(enumerate(self.outbox[:limit], start=1))

    def mark_outbox_sent(self, outbox_id: int) -> None:
        index = outbox_id - 1
        if 0 <= index < len(self.outbox):
            self.outbox.pop(index)

    def mark_outbox_failed(self, outbox_id: int, error: str) -> None:
        return None


class RawCipher:
    def __init__(self, key: bytes) -> None:
        if len(key) not in {16, 24, 32}:
            raise ValueError("raw encryption key must be 16, 24 or 32 bytes")
        self._aes = AESGCM(key)

    @classmethod
    def from_env(cls) -> "RawCipher":
        import base64

        value = os.environ.get("WHATSAPP_RAW_ENCRYPTION_KEY_B64")
        if not value:
            raise RuntimeError("WHATSAPP_RAW_ENCRYPTION_KEY_B64 is required")
        return cls(base64.b64decode(value, validate=True))

    def encrypt(self, payload: bytes, aad: bytes) -> tuple[bytes, bytes]:
        nonce = os.urandom(12)
        return nonce, self._aes.encrypt(nonce, payload, aad)


class PostgresFreightStore:
    def __init__(self, database_url: str, cipher: RawCipher) -> None:
        self.database_url = database_url
        self.cipher = cipher

    @classmethod
    def from_env(cls) -> "PostgresFreightStore":
        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("DATABASE_URL is required")
        return cls(url, RawCipher.from_env())

    def ensure_schema(self) -> None:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                CREATE TABLE IF NOT EXISTS whatsapp_raw_events (
                    tenant_id text NOT NULL,
                    provider text NOT NULL,
                    source_event_id text NOT NULL,
                    source text NOT NULL,
                    message_timestamp timestamptz NOT NULL,
                    ingestion_timestamp timestamptz NOT NULL DEFAULT now(),
                    payload_hash text NOT NULL,
                    nonce bytea NOT NULL,
                    ciphertext bytea NOT NULL,
                    attachment_metadata jsonb NOT NULL DEFAULT '[]'::jsonb,
                    PRIMARY KEY (tenant_id, provider, source_event_id)
                );
                CREATE TABLE IF NOT EXISTS whatsapp_freight_events (
                    tenant_id text NOT NULL,
                    logical_key text NOT NULL,
                    event_id uuid NOT NULL,
                    version integer NOT NULL,
                    payload jsonb NOT NULL,
                    updated_at timestamptz NOT NULL DEFAULT now(),
                    PRIMARY KEY (tenant_id, logical_key),
                    UNIQUE (event_id)
                );
                CREATE TABLE IF NOT EXISTS whatsapp_processed_source_events (
                    tenant_id text NOT NULL,
                    provider text NOT NULL,
                    source_event_id text NOT NULL,
                    processed_at timestamptz NOT NULL DEFAULT now(),
                    PRIMARY KEY (tenant_id, provider, source_event_id)
                );
                CREATE TABLE IF NOT EXISTS whatsapp_agrolog_outbox (
                    outbox_id bigserial PRIMARY KEY,
                    tenant_id text NOT NULL,
                    event_id uuid NOT NULL,
                    event_version integer NOT NULL,
                    payload jsonb NOT NULL,
                    status text NOT NULL DEFAULT 'PENDING',
                    attempts integer NOT NULL DEFAULT 0,
                    created_at timestamptz NOT NULL DEFAULT now(),
                    sent_at timestamptz,
                    next_attempt_at timestamptz NOT NULL DEFAULT now(),
                    last_error text,
                    UNIQUE (event_id, event_version)
                );
                """)
            conn.commit()

    def save_raw(self, tenant_id: str, provider: str, event: RawInboundEvent) -> str:
        raw = event.model_dump_json().encode("utf-8")
        digest = sha256_hex(raw)
        aad = f"{tenant_id}:{provider}:{event.source_event_id}".encode("utf-8")
        nonce, ciphertext = self.cipher.encrypt(raw, aad)
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO whatsapp_raw_events
                    (tenant_id, provider, source_event_id, source, message_timestamp, payload_hash, nonce, ciphertext, attachment_metadata)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                    ON CONFLICT (tenant_id, provider, source_event_id) DO NOTHING
                    """,
                    (
                        tenant_id, provider, event.source_event_id, event.source,
                        event.message_timestamp, digest, nonce, ciphertext,
                        json.dumps([a.model_dump(mode="json") for a in event.attachments]),
                    ),
                )
            conn.commit()
        return f"postgres://whatsapp_raw_events/{tenant_id}/{provider}/{event.source_event_id}"

    def has_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> bool:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM whatsapp_processed_source_events WHERE tenant_id=%s AND provider=%s AND source_event_id=%s",
                    (tenant_id, provider, source_event_id),
                )
                return cur.fetchone() is not None

    def mark_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> None:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO whatsapp_processed_source_events (tenant_id, provider, source_event_id)
                    VALUES (%s,%s,%s) ON CONFLICT DO NOTHING
                    """,
                    (tenant_id, provider, source_event_id),
                )
            conn.commit()

    def find_logical_event(self, tenant_id: str, logical_key: str) -> FreightEvent | None:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT payload FROM whatsapp_freight_events WHERE tenant_id=%s AND logical_key=%s",
                    (tenant_id, logical_key),
                )
                row = cur.fetchone()
        return FreightEvent.model_validate(row[0]) if row else None

    def save_event(self, event: FreightEvent, logical_key: str) -> None:
        payload = event.model_dump(mode="json")
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO whatsapp_freight_events (tenant_id, logical_key, event_id, version, payload)
                    VALUES (%s,%s,%s,%s,%s::jsonb)
                    ON CONFLICT (tenant_id, logical_key) DO UPDATE
                    SET event_id=EXCLUDED.event_id, version=EXCLUDED.version, payload=EXCLUDED.payload, updated_at=now()
                    """,
                    (event.tenant_id, logical_key, event.event_id, event.version, json.dumps(payload)),
                )
            conn.commit()

    def enqueue_outbox(self, event: FreightEvent) -> None:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO whatsapp_agrolog_outbox
                    (tenant_id, event_id, event_version, payload)
                    VALUES (%s,%s,%s,%s::jsonb)
                    ON CONFLICT (event_id, event_version) DO NOTHING
                    """,
                    (event.tenant_id, event.event_id, event.version, json.dumps(event.model_dump(mode="json"))),
                )
            conn.commit()

    def pending_outbox(self, limit: int = 100) -> list[tuple[int, FreightEvent]]:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT outbox_id, payload
                    FROM whatsapp_agrolog_outbox
                    WHERE status='PENDING' AND next_attempt_at <= now()
                    ORDER BY outbox_id
                    LIMIT %s
                    FOR UPDATE SKIP LOCKED
                    """,
                    (limit,),
                )
                rows = cur.fetchall()
        return [(int(row[0]), FreightEvent.model_validate(row[1])) for row in rows]

    def mark_outbox_sent(self, outbox_id: int) -> None:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE whatsapp_agrolog_outbox
                    SET status='SENT', sent_at=now(), last_error=NULL
                    WHERE outbox_id=%s
                    """,
                    (outbox_id,),
                )
            conn.commit()

    def mark_outbox_failed(self, outbox_id: int, error: str) -> None:
        with psycopg.connect(self.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE whatsapp_agrolog_outbox
                    SET attempts=attempts+1,
                        last_error=%s,
                        next_attempt_at=now() + make_interval(secs => LEAST(3600, 30 * power(2, LEAST(attempts, 7))))
                    WHERE outbox_id=%s
                    """,
                    (error[:1000], outbox_id),
                )
            conn.commit()
