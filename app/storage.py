from __future__ import annotations

import json
import os
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
    def recent_events(self, tenant_id: str, limit: int = 100) -> list[tuple[str, FreightEvent]]: ...
    def save_event(self, event: FreightEvent, logical_key: str) -> None: ...
    def enqueue_outbox(self, event: FreightEvent) -> None: ...
    def pending_outbox(self, tenant_id: str, limit: int = 100) -> list[tuple[int, FreightEvent]]: ...
    def mark_outbox_sent(self, tenant_id: str, outbox_id: int) -> None: ...
    def mark_outbox_failed(self, tenant_id: str, outbox_id: int, error: str) -> None: ...
    def readiness_check(self) -> None: ...
    def outbox_status_counts(self, tenant_id: str) -> dict[str, int]: ...


class InMemoryFreightStore:
    """Test-only store. Production must use PostgresFreightStore."""

    def __init__(self, max_outbox_attempts: int = 8) -> None:
        self.raw: list[dict] = []
        self.source_ids: set[tuple[str, str, str]] = set()
        self.events: dict[tuple[str, str], FreightEvent] = {}
        self.event_versions: dict[tuple[str, str, int], FreightEvent] = {}
        self.outbox: dict[int, FreightEvent] = {}
        self.dead_outbox: dict[int, FreightEvent] = {}
        self.outbox_attempts: dict[int, int] = {}
        self._next_outbox_id = 1
        self.max_outbox_attempts = max_outbox_attempts

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

    def recent_events(self, tenant_id: str, limit: int = 100) -> list[tuple[str, FreightEvent]]:
        rows = [
            (logical_key, event)
            for (event_tenant, logical_key), event in self.events.items()
            if event_tenant == tenant_id
        ]
        rows.sort(key=lambda item: item[1].timestamp, reverse=True)
        return rows[:limit]

    def save_event(self, event: FreightEvent, logical_key: str) -> None:
        self.event_versions.setdefault(
            (event.tenant_id, event.event_id, event.version),
            event.model_copy(deep=True),
        )
        self.events[(event.tenant_id, logical_key)] = event

    def enqueue_outbox(self, event: FreightEvent) -> None:
        all_events = [*self.outbox.values(), *self.dead_outbox.values()]
        if any(e.event_id == event.event_id and e.version == event.version for e in all_events):
            return
        outbox_id = self._next_outbox_id
        self._next_outbox_id += 1
        self.outbox[outbox_id] = event
        self.outbox_attempts[outbox_id] = 0

    def pending_outbox(self, tenant_id: str, limit: int = 100) -> list[tuple[int, FreightEvent]]:
        return [
            (outbox_id, event)
            for outbox_id, event in sorted(self.outbox.items())
            if event.tenant_id == tenant_id
        ][:limit]

    def mark_outbox_sent(self, tenant_id: str, outbox_id: int) -> None:
        event = self.outbox.get(outbox_id)
        if event is None or event.tenant_id != tenant_id:
            return
        self.outbox.pop(outbox_id, None)
        self.outbox_attempts.pop(outbox_id, None)

    def mark_outbox_failed(self, tenant_id: str, outbox_id: int, error: str) -> None:
        event = self.outbox.get(outbox_id)
        if event is None or event.tenant_id != tenant_id:
            return
        attempts = self.outbox_attempts.get(outbox_id, 0) + 1
        self.outbox_attempts[outbox_id] = attempts
        if attempts >= self.max_outbox_attempts:
            self.dead_outbox[outbox_id] = self.outbox.pop(outbox_id)

    def readiness_check(self) -> None:
        return None

    def outbox_status_counts(self, tenant_id: str) -> dict[str, int]:
        pending = sum(1 for event in self.outbox.values() if event.tenant_id == tenant_id)
        dead = sum(1 for event in self.dead_outbox.values() if event.tenant_id == tenant_id)
        return {
            "PENDING": pending,
            "PROCESSING": 0,
            "SENT": 0,
            "DEAD": dead,
        }


class RawCipher:
    def __init__(self, key: bytes) -> None:
        if len(key) not in {16, 24, 32}:
            raise ValueError("raw encryption key must be 16, 24 or 32 bytes")
        self._aes = AESGCM(key)

    @classmethod
    def from_env(cls) -> RawCipher:
        import base64

        value = os.environ.get("WHATSAPP_RAW_ENCRYPTION_KEY_B64")
        if not value:
            raise RuntimeError("WHATSAPP_RAW_ENCRYPTION_KEY_B64 is required")
        return cls(base64.b64decode(value, validate=True))

    def encrypt(self, payload: bytes, aad: bytes) -> tuple[bytes, bytes]:
        nonce = os.urandom(12)
        return nonce, self._aes.encrypt(nonce, payload, aad)


class PostgresFreightStore:
    def __init__(
        self,
        database_url: str,
        cipher: RawCipher | None,
        *,
        worker_mode: bool = False,
        max_outbox_attempts: int = 8,
        claim_timeout_seconds: int = 300,
    ) -> None:
        if not 1 <= max_outbox_attempts <= 100:
            raise ValueError("max_outbox_attempts must be between 1 and 100")
        if not 30 <= claim_timeout_seconds <= 3600:
            raise ValueError("claim_timeout_seconds must be between 30 and 3600")
        self.database_url = database_url
        self.cipher = cipher
        self.worker_mode = worker_mode
        self.max_outbox_attempts = max_outbox_attempts
        self.claim_timeout_seconds = claim_timeout_seconds

    @classmethod
    def from_env(cls, *, worker: bool = False) -> PostgresFreightStore:
        env_name = "DATABASE_URL_WORKER" if worker else "DATABASE_URL"
        url = os.environ.get(env_name)
        if not url:
            raise RuntimeError(f"{env_name} is required")
        return cls(
            url,
            None if worker else RawCipher.from_env(),
            worker_mode=worker,
            max_outbox_attempts=int(os.environ.get("OUTBOX_MAX_ATTEMPTS", "8")),
            claim_timeout_seconds=int(os.environ.get("OUTBOX_CLAIM_TIMEOUT_SECONDS", "300")),
        )

    @staticmethod
    def _set_tenant(cur, tenant_id: str) -> None:
        if not tenant_id or len(tenant_id) > 128:
            raise ValueError("invalid tenant_id")
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))

    def _require_worker(self) -> None:
        if not self.worker_mode:
            raise RuntimeError("outbox dispatch requires DATABASE_URL_WORKER")

    def save_raw(self, tenant_id: str, provider: str, event: RawInboundEvent) -> str:
        if self.cipher is None:
            raise RuntimeError("raw encryption is unavailable in worker mode")
        raw = event.model_dump_json().encode()
        digest = sha256_hex(raw)
        aad = f"{tenant_id}:{provider}:{event.source_event_id}".encode()
        nonce, ciphertext = self.cipher.encrypt(raw, aad)
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                INSERT INTO whatsapp_raw_events
                (tenant_id, provider, source_event_id, source, message_timestamp, payload_hash, nonce, ciphertext, attachment_metadata)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                ON CONFLICT (tenant_id, provider, source_event_id) DO NOTHING
                """,
                (
                    tenant_id,
                    provider,
                    event.source_event_id,
                    event.source,
                    event.message_timestamp,
                    digest,
                    nonce,
                    ciphertext,
                    json.dumps([a.model_dump(mode="json") for a in event.attachments]),
                ),
            )
            conn.commit()
        return f"postgres://whatsapp_raw_events/{tenant_id}/{provider}/{event.source_event_id}"

    def has_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> bool:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                "SELECT 1 FROM whatsapp_processed_source_events WHERE tenant_id=%s AND provider=%s AND source_event_id=%s",
                (tenant_id, provider, source_event_id),
            )
            return cur.fetchone() is not None

    def mark_source_event(self, tenant_id: str, provider: str, source_event_id: str) -> None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                INSERT INTO whatsapp_processed_source_events (tenant_id, provider, source_event_id)
                VALUES (%s,%s,%s) ON CONFLICT DO NOTHING
                """,
                (tenant_id, provider, source_event_id),
            )
            conn.commit()

    def find_logical_event(self, tenant_id: str, logical_key: str) -> FreightEvent | None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                "SELECT payload FROM whatsapp_freight_events WHERE tenant_id=%s AND logical_key=%s",
                (tenant_id, logical_key),
            )
            row = cur.fetchone()
        return FreightEvent.model_validate(row[0]) if row else None

    def recent_events(self, tenant_id: str, limit: int = 100) -> list[tuple[str, FreightEvent]]:
        limit = max(1, min(limit, 500))
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                SELECT logical_key, payload
                FROM whatsapp_freight_events
                WHERE tenant_id=%s
                ORDER BY updated_at DESC
                LIMIT %s
                """,
                (tenant_id, limit),
            )
            rows = cur.fetchall()
        return [(str(row[0]), FreightEvent.model_validate(row[1])) for row in rows]

    def save_event(self, event: FreightEvent, logical_key: str) -> None:
        payload = event.model_dump(mode="json")
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, event.tenant_id)
            cur.execute(
                """
                INSERT INTO whatsapp_freight_event_versions
                (tenant_id, event_id, version, logical_key, payload, observed_at)
                VALUES (%s,%s,%s,%s,%s::jsonb,%s)
                ON CONFLICT (tenant_id, event_id, version) DO NOTHING
                """,
                (
                    event.tenant_id,
                    event.event_id,
                    event.version,
                    logical_key,
                    json.dumps(payload),
                    event.timestamp,
                ),
            )
            cur.execute(
                """
                INSERT INTO whatsapp_freight_events (tenant_id, logical_key, event_id, version, payload)
                VALUES (%s,%s,%s,%s,%s::jsonb)
                ON CONFLICT (tenant_id, logical_key) DO UPDATE
                SET event_id=EXCLUDED.event_id, version=EXCLUDED.version, payload=EXCLUDED.payload, updated_at=now()
                """,
                (
                    event.tenant_id,
                    logical_key,
                    event.event_id,
                    event.version,
                    json.dumps(payload),
                ),
            )
            conn.commit()

    def enqueue_outbox(self, event: FreightEvent) -> None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, event.tenant_id)
            cur.execute(
                """
                INSERT INTO whatsapp_agrolog_outbox
                (tenant_id, event_id, event_version, payload)
                VALUES (%s,%s,%s,%s::jsonb)
                ON CONFLICT (event_id, event_version) DO NOTHING
                """,
                (
                    event.tenant_id,
                    event.event_id,
                    event.version,
                    json.dumps(event.model_dump(mode="json")),
                ),
            )
            conn.commit()

    def pending_outbox(self, tenant_id: str, limit: int = 100) -> list[tuple[int, FreightEvent]]:
        self._require_worker()
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                WITH claimed AS (
                    SELECT outbox_id
                    FROM whatsapp_agrolog_outbox
                    WHERE tenant_id=%s
                      AND (
                        (status='PENDING' AND next_attempt_at <= now())
                        OR (
                            status='PROCESSING'
                            AND processing_started_at < now() - make_interval(secs => %s)
                        )
                      )
                    ORDER BY outbox_id
                    LIMIT %s
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE whatsapp_agrolog_outbox AS o
                SET status='PROCESSING', processing_started_at=now()
                FROM claimed
                WHERE o.outbox_id = claimed.outbox_id
                  AND o.tenant_id=%s
                RETURNING o.outbox_id, o.payload
                """,
                (tenant_id, self.claim_timeout_seconds, limit, tenant_id),
            )
            rows = cur.fetchall()
            conn.commit()
        return [(int(row[0]), FreightEvent.model_validate(row[1])) for row in rows]

    def mark_outbox_sent(self, tenant_id: str, outbox_id: int) -> None:
        self._require_worker()
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                UPDATE whatsapp_agrolog_outbox
                SET status='SENT', sent_at=now(), last_error=NULL, processing_started_at=NULL
                WHERE outbox_id=%s AND tenant_id=%s
                """,
                (outbox_id, tenant_id),
            )
            conn.commit()

    def mark_outbox_failed(self, tenant_id: str, outbox_id: int, error: str) -> None:
        self._require_worker()
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                UPDATE whatsapp_agrolog_outbox
                SET attempts=attempts+1,
                    status=CASE
                        WHEN attempts+1 >= %s THEN 'DEAD'
                        ELSE 'PENDING'
                    END,
                    dead_at=CASE
                        WHEN attempts+1 >= %s THEN now()
                        ELSE NULL
                    END,
                    last_error=%s,
                    processing_started_at=NULL,
                    next_attempt_at=CASE
                        WHEN attempts+1 >= %s THEN next_attempt_at
                        ELSE now() + make_interval(
                            secs => LEAST(3600, 30 * power(2, LEAST(attempts, 7)))
                        )
                    END
                WHERE outbox_id=%s AND tenant_id=%s
                """,
                (
                    self.max_outbox_attempts,
                    self.max_outbox_attempts,
                    error[:1000],
                    self.max_outbox_attempts,
                    outbox_id,
                    tenant_id,
                ),
            )
            conn.commit()

    def readiness_check(self) -> None:
        if self.worker_mode:
            raise RuntimeError("ingress readiness cannot use worker credentials")
        with psycopg.connect(self.database_url, connect_timeout=5) as conn, conn.cursor() as cur:
            self._set_tenant(cur, "__healthcheck__")
            cur.execute(
                """
                SELECT 1
                FROM whatsapp_processed_source_events
                WHERE tenant_id=%s
                LIMIT 1
                """,
                ("__healthcheck__",),
            )

    def outbox_status_counts(self, tenant_id: str) -> dict[str, int]:
        self._require_worker()
        counts = {"PENDING": 0, "PROCESSING": 0, "SENT": 0, "DEAD": 0}
        with psycopg.connect(self.database_url, connect_timeout=5) as conn, conn.cursor() as cur:
            self._set_tenant(cur, tenant_id)
            cur.execute(
                """
                SELECT status, count(*)
                FROM whatsapp_agrolog_outbox
                WHERE tenant_id=%s
                GROUP BY status
                """,
                (tenant_id,),
            )
            for status, count in cur.fetchall():
                if status in counts:
                    counts[str(status)] = int(count)
        return counts
