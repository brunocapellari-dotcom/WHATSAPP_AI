from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException, Request, status

from .models import AttachmentMetadata, RawInboundEvent
from .security import validate_egress_url

logger = logging.getLogger("whatsapp_ai.provider_bridge")

MAX_WPP_BODY_BYTES = int(os.environ.get("BRIDGE_MAX_WEBHOOK_BYTES", "5000000"))
MAX_RAW_TEXT = 50_000
MAX_RAW_EVENT_BYTES = 700_000
ID_RE = re.compile(r"^[A-Za-z0-9._:@-]{1,256}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
BASE64ISH_RE = re.compile(r"^[A-Za-z0-9+/=\r\n]+$")
PERMANENT_HTTP_STATUSES = {400, 401, 403, 404, 413, 415, 422}


class BridgeConfigError(RuntimeError):
    pass


class BridgeCipher:
    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise BridgeConfigError("BRIDGE_OUTBOX_KEY_B64 must decode to exactly 32 bytes")
        self._aes = AESGCM(key)

    @classmethod
    def from_env(cls) -> "BridgeCipher":
        raw = os.environ.get("BRIDGE_OUTBOX_KEY_B64")
        if not raw:
            raise BridgeConfigError("BRIDGE_OUTBOX_KEY_B64 is required")
        try:
            key = base64.b64decode(raw, validate=True)
        except ValueError as exc:
            raise BridgeConfigError("BRIDGE_OUTBOX_KEY_B64 is invalid base64") from exc
        return cls(key)

    def encrypt(self, payload: bytes, aad: bytes) -> tuple[bytes, bytes]:
        nonce = os.urandom(12)
        return nonce, self._aes.encrypt(nonce, payload, aad)

    def decrypt(self, nonce: bytes, ciphertext: bytes, aad: bytes) -> bytes:
        return self._aes.decrypt(nonce, ciphertext, aad)


class SQLiteBridgeOutbox:
    def __init__(
        self,
        path: str,
        cipher: BridgeCipher,
        *,
        max_attempts: int = 8,
        claim_timeout_seconds: int = 300,
    ) -> None:
        if not 1 <= max_attempts <= 100:
            raise ValueError("max_attempts must be between 1 and 100")
        if not 30 <= claim_timeout_seconds <= 3600:
            raise ValueError("claim_timeout_seconds must be between 30 and 3600")
        self.path = Path(path)
        self.cipher = cipher
        self.max_attempts = max_attempts
        self.claim_timeout_seconds = claim_timeout_seconds

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA busy_timeout=10000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def ensure_schema(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS provider_outbox (
                    outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_event_id TEXT NOT NULL UNIQUE,
                    nonce BLOB NOT NULL,
                    ciphertext BLOB NOT NULL,
                    status TEXT NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','PROCESSING','SENT','DEAD')),
                    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                    next_attempt_at REAL NOT NULL DEFAULT (unixepoch()),
                    processing_started_at REAL,
                    created_at REAL NOT NULL DEFAULT (unixepoch()),
                    sent_at REAL,
                    dead_at REAL,
                    last_error TEXT
                );
                CREATE INDEX IF NOT EXISTS provider_outbox_dispatch_idx
                    ON provider_outbox(status, next_attempt_at, outbox_id);
                """
            )
        os.chmod(self.path, 0o600)

    def enqueue(self, event: RawInboundEvent) -> bool:
        payload = event.model_dump_json().encode("utf-8")
        aad = event.source_event_id.encode("utf-8")
        nonce, ciphertext = self.cipher.encrypt(payload, aad)
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO provider_outbox
                (source_event_id, nonce, ciphertext)
                VALUES (?, ?, ?)
                """,
                (event.source_event_id, nonce, ciphertext),
            )
            return cursor.rowcount == 1

    def claim(self, limit: int = 25) -> list[tuple[int, RawInboundEvent]]:
        now = time.time()
        stale_before = now - self.claim_timeout_seconds
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                """
                SELECT outbox_id, source_event_id, nonce, ciphertext
                FROM provider_outbox
                WHERE
                    (status='PENDING' AND next_attempt_at <= ?)
                    OR (
                        status='PROCESSING'
                        AND processing_started_at < ?
                    )
                ORDER BY outbox_id
                LIMIT ?
                """,
                (now, stale_before, max(1, min(limit, 100))),
            ).fetchall()
            ids = [int(row["outbox_id"]) for row in rows]
            for outbox_id in ids:
                conn.execute(
                    """
                    UPDATE provider_outbox
                    SET status='PROCESSING', processing_started_at=?
                    WHERE outbox_id=?
                    """,
                    (now, outbox_id),
                )
            conn.execute("COMMIT")

        result: list[tuple[int, RawInboundEvent]] = []
        for row in rows:
            outbox_id = int(row["outbox_id"])
            source_id = str(row["source_event_id"])
            try:
                payload = self.cipher.decrypt(
                    bytes(row["nonce"]),
                    bytes(row["ciphertext"]),
                    source_id.encode("utf-8"),
                )
                event = RawInboundEvent.model_validate_json(payload)
            except (InvalidTag, ValueError) as exc:
                self.mark_failed(
                    outbox_id,
                    f"{type(exc).__name__}: encrypted outbox payload invalid",
                    permanent=True,
                )
                logger.error(
                    json.dumps(
                        {
                            "event": "bridge_outbox_corrupt",
                            "outbox_id": outbox_id,
                            "error_type": type(exc).__name__,
                        },
                        sort_keys=True,
                    )
                )
                continue
            result.append((outbox_id, event))
        return result

    def mark_sent(self, outbox_id: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE provider_outbox
                SET status='SENT', sent_at=?, processing_started_at=NULL, last_error=NULL
                WHERE outbox_id=?
                """,
                (time.time(), outbox_id),
            )

    def mark_failed(self, outbox_id: int, error: str, *, permanent: bool = False) -> None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT attempts FROM provider_outbox WHERE outbox_id=?",
                (outbox_id,),
            ).fetchone()
            if row is None:
                return
            attempts = int(row["attempts"]) + 1
            dead = permanent or attempts >= self.max_attempts
            if dead:
                conn.execute(
                    """
                    UPDATE provider_outbox
                    SET attempts=?, status='DEAD', dead_at=?,
                        processing_started_at=NULL, last_error=?
                    WHERE outbox_id=?
                    """,
                    (attempts, time.time(), error[:1000], outbox_id),
                )
                return
            delay = min(3600, 30 * (2 ** min(attempts - 1, 7)))
            conn.execute(
                """
                UPDATE provider_outbox
                SET attempts=?, status='PENDING', next_attempt_at=?,
                    processing_started_at=NULL, last_error=?
                WHERE outbox_id=?
                """,
                (attempts, time.time() + delay, error[:1000], outbox_id),
            )

    def status_counts(self) -> dict[str, int]:
        counts = {"PENDING": 0, "PROCESSING": 0, "SENT": 0, "DEAD": 0}
        with self._connect() as conn:
            for row in conn.execute(
                "SELECT status, count(*) AS count FROM provider_outbox GROUP BY status"
            ):
                status_name = str(row["status"])
                if status_name in counts:
                    counts[status_name] = int(row["count"])
        return counts


def _str_or_none(value: Any, *, max_length: int = 512) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    return value[:max_length]


def _timestamp(payload: dict[str, Any]) -> datetime:
    value = payload.get("timestamp", payload.get("t"))
    if not isinstance(value, (int, float)):
        raise ValueError("WPPConnect message timestamp is missing")
    now = time.time()
    if value < 946684800 or value > now + 86400:
        raise ValueError("WPPConnect message timestamp is outside accepted range")
    return datetime.fromtimestamp(value, tz=UTC)


def _looks_like_media_bytes(value: str) -> bool:
    stripped = value.strip()
    return len(stripped) > 8192 and bool(BASE64ISH_RE.fullmatch(stripped))


def _sanitized_raw_event(payload: dict[str, Any]) -> dict[str, Any]:
    drop_keys = {
        "mediaKey",
        "directPath",
        "deprecatedMms3Url",
        "clientUrl",
        "uploadhash",
        "chat",
        "sender",
        "mediaData",
        "interactiveAnnotations",
        "labels",
    }
    sanitized = {key: value for key, value in payload.items() if key not in drop_keys}

    if bool(payload.get("isMedia") or payload.get("isMMS")):
        body = sanitized.get("body")
        if isinstance(body, str) and _looks_like_media_bytes(body):
            sanitized["body"] = "[MEDIA_BYTES_REDACTED]"
            sanitized["media_bytes_redacted"] = True

    encoded = json.dumps(
        sanitized,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    if len(encoded) <= MAX_RAW_EVENT_BYTES:
        return sanitized

    original = json.dumps(
        payload,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    keep = {
        key: sanitized.get(key)
        for key in (
            "event",
            "session",
            "id",
            "type",
            "timestamp",
            "t",
            "from",
            "to",
            "author",
            "notifyName",
            "isGroupMsg",
            "isMedia",
            "isMMS",
            "fromMe",
            "mimetype",
            "filehash",
            "size",
            "caption",
            "quotedMsgId",
        )
        if key in sanitized
    }
    body = sanitized.get("body")
    if isinstance(body, str):
        keep["body"] = body[:MAX_RAW_TEXT]
    keep["_raw_event_truncated"] = True
    keep["_raw_event_original_size_bytes"] = len(original)
    keep["_raw_event_sha256"] = hashlib.sha256(original).hexdigest()
    return keep


def normalize_wppconnect_event(
    payload: dict[str, Any],
    *,
    allowed_sessions: set[str],
) -> RawInboundEvent | None:
    if payload.get("event") != "onmessage":
        return None

    session = _str_or_none(payload.get("session"), max_length=128)
    if session is None or session not in allowed_sessions:
        raise ValueError("WPPConnect session is not allowlisted")

    if payload.get("fromMe") is True:
        return None

    provider_message_id = _str_or_none(payload.get("id"), max_length=256)
    if provider_message_id is None or not ID_RE.fullmatch(provider_message_id):
        raise ValueError("WPPConnect message id is invalid")
    composite_id = f"{session}:{provider_message_id}"
    if len(composite_id) <= 256 and ID_RE.fullmatch(composite_id):
        source_event_id = composite_id
    else:
        source_event_id = (
            "wpp-"
            + hashlib.sha256(composite_id.encode("utf-8")).hexdigest()
        )

    message_timestamp = _timestamp(payload)
    is_media = bool(payload.get("isMedia") or payload.get("isMMS"))
    caption = _str_or_none(payload.get("caption"), max_length=MAX_RAW_TEXT)
    body = _str_or_none(payload.get("body"), max_length=MAX_RAW_TEXT)

    if is_media and body and _looks_like_media_bytes(body):
        body = None
    raw_text = caption or body or ""

    chat_id = _str_or_none(payload.get("chatId"), max_length=256)
    sender = _str_or_none(payload.get("from"), max_length=256)
    source_suffix = chat_id or sender or "unknown"
    source = f"wppconnect:{session}:{source_suffix}"[:256]

    attachments: list[AttachmentMetadata] = []
    mime = _str_or_none(payload.get("mimetype"), max_length=128)
    if is_media or mime:
        provider_hash = _str_or_none(payload.get("filehash"), max_length=128)
        content_hash = provider_hash if provider_hash and SHA256_RE.fullmatch(provider_hash) else None
        size = payload.get("size")
        size_bytes = size if isinstance(size, int) and 0 <= size <= 50_000_000 else None
        filename = _str_or_none(payload.get("filename"), max_length=512)
        attachments.append(
            AttachmentMetadata(
                attachment_id=f"{source_event_id}:0",
                filename=filename,
                mime_type=mime,
                size_bytes=size_bytes,
                content_hash=content_hash,
                storage_reference=None,
            )
        )

    raw_event = _sanitized_raw_event(payload)
    metadata = {
        "provider": "wppconnect",
        "session": session,
        "provider_message_id": provider_message_id,
        "from": sender,
        "to": _str_or_none(payload.get("to"), max_length=256),
        "author": _str_or_none(payload.get("author"), max_length=256),
        "chat_id": chat_id,
        "message_type": _str_or_none(payload.get("type"), max_length=64),
        "notify_name": _str_or_none(payload.get("notifyName"), max_length=256),
        "is_group": bool(payload.get("isGroupMsg")),
        "is_media": is_media,
        "provider_filehash": _str_or_none(payload.get("filehash"), max_length=128),
        "quoted_message_id": _str_or_none(payload.get("quotedMsgId"), max_length=256),
        "media_bytes_accepted": False,
    }

    quoted_id = metadata["quoted_message_id"]
    if isinstance(quoted_id, str):
        quoted_composite = f"{session}:{quoted_id}"
        if len(quoted_composite) <= 256 and ID_RE.fullmatch(quoted_composite):
            metadata["reply_to_source_event_id"] = quoted_composite

    return RawInboundEvent(
        source_event_id=source_event_id,
        source=source,
        message_timestamp=message_timestamp,
        raw_text=raw_text,
        raw_event=raw_event,
        attachments=attachments,
        metadata=metadata,
    )


class BridgeDispatcher:
    def __init__(
        self,
        outbox: SQLiteBridgeOutbox,
        *,
        endpoint: str,
        tenant_id: str,
        provider: str,
        hmac_secret: str,
        allowed_hosts: set[str],
        timeout_seconds: float = 10.0,
    ) -> None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", provider):
            raise BridgeConfigError("bridge provider id is invalid")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", tenant_id):
            raise BridgeConfigError("bridge tenant id is invalid")
        if not hmac_secret:
            raise BridgeConfigError("bridge HMAC secret is empty")
        validated_endpoint = validate_egress_url(endpoint, allowed_hosts)
        expected_path = f"/v1/providers/{provider}/events"
        if urlparse(validated_endpoint).path != expected_path:
            raise BridgeConfigError(
                f"BRIDGE_TARGET_URL path must be exactly {expected_path}"
            )
        self.outbox = outbox
        self.endpoint = validated_endpoint
        self.tenant_id = tenant_id
        self.provider = provider
        self.hmac_secret = hmac_secret
        self.timeout_seconds = timeout_seconds

    def send_once(self, event: RawInboundEvent) -> httpx.Response:
        body = json.dumps(
            event.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        timestamp = str(int(time.time()))
        signature = hmac.new(
            self.hmac_secret.encode("utf-8"),
            timestamp.encode("ascii") + b"." + body,
            hashlib.sha256,
        ).hexdigest()
        return httpx.post(
            self.endpoint,
            content=body,
            headers={
                "content-type": "application/json",
                "x-tenant-id": self.tenant_id,
                "x-webhook-timestamp": timestamp,
                "x-webhook-signature": f"sha256={signature}",
            },
            timeout=self.timeout_seconds,
        )

    def flush(self, limit: int = 25) -> dict[str, int]:
        sent = 0
        failed = 0
        for outbox_id, event in self.outbox.claim(limit):
            try:
                response = self.send_once(event)
                if 200 <= response.status_code < 300:
                    self.outbox.mark_sent(outbox_id)
                    sent += 1
                    continue
                permanent = response.status_code in PERMANENT_HTTP_STATUSES
                self.outbox.mark_failed(
                    outbox_id,
                    f"HTTP {response.status_code}",
                    permanent=permanent,
                )
                failed += 1
            except httpx.HTTPError as exc:
                self.outbox.mark_failed(
                    outbox_id,
                    f"{type(exc).__name__}: transport failure",
                )
                failed += 1
        return {"sent": sent, "failed": failed}


def _allowed_sessions() -> set[str]:
    sessions = {
        item.strip()
        for item in os.environ.get("WPP_ALLOWED_SESSIONS", "").split(",")
        if item.strip()
    }
    if not sessions:
        raise BridgeConfigError("WPP_ALLOWED_SESSIONS is required")
    return sessions


def _outbox_from_env() -> SQLiteBridgeOutbox:
    outbox = SQLiteBridgeOutbox(
        os.environ.get("BRIDGE_DB_PATH", "/data/bridge/outbox.sqlite3"),
        BridgeCipher.from_env(),
        max_attempts=int(os.environ.get("BRIDGE_MAX_ATTEMPTS", "8")),
        claim_timeout_seconds=int(os.environ.get("BRIDGE_CLAIM_TIMEOUT_SECONDS", "300")),
    )
    outbox.ensure_schema()
    return outbox


def _dispatcher_from_env(outbox: SQLiteBridgeOutbox) -> BridgeDispatcher:
    endpoint = os.environ.get("BRIDGE_TARGET_URL")
    tenant = os.environ.get("BRIDGE_TENANT_ID")
    provider = os.environ.get("BRIDGE_PROVIDER_ID", "wppconnect")
    secret = os.environ.get("BRIDGE_PROVIDER_HMAC_SECRET")
    hosts = {
        item.strip()
        for item in os.environ.get("BRIDGE_EGRESS_ALLOWED_HOSTS", "").split(",")
        if item.strip()
    }
    if not endpoint or not tenant or not secret:
        raise BridgeConfigError(
            "BRIDGE_TARGET_URL, BRIDGE_TENANT_ID and BRIDGE_PROVIDER_HMAC_SECRET are required"
        )
    return BridgeDispatcher(
        outbox,
        endpoint=endpoint,
        tenant_id=tenant,
        provider=provider,
        hmac_secret=secret,
        allowed_hosts=hosts,
    )


async def _dispatch_loop(app: FastAPI) -> None:
    interval = max(1, min(int(os.environ.get("BRIDGE_FLUSH_INTERVAL_SECONDS", "5")), 60))
    while True:
        try:
            dispatcher: BridgeDispatcher = app.state.dispatcher
            result = await asyncio.to_thread(dispatcher.flush)
            if result["sent"] or result["failed"]:
                logger.info(
                    json.dumps(
                        {"event": "bridge_dispatch", **result},
                        sort_keys=True,
                    )
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(
                json.dumps(
                    {
                        "event": "bridge_dispatch_error",
                        "error_type": type(exc).__name__,
                    },
                    sort_keys=True,
                )
            )
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    outbox = _outbox_from_env()
    app.state.outbox = outbox
    app.state.dispatcher = _dispatcher_from_env(outbox)
    app.state.allowed_sessions = _allowed_sessions()
    task = asyncio.create_task(_dispatch_loop(app))
    app.state.dispatch_task = task
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


app = FastAPI(
    title="WhatsApp AI WPPConnect Bridge",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz(request: Request) -> dict[str, Any]:
    outbox: SQLiteBridgeOutbox = request.app.state.outbox
    counts = outbox.status_counts()
    if counts["DEAD"] > 0:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="bridge dead-letter queue is not empty",
        )
    return {"status": "ready", "queue": counts}


@app.post("/v1/wppconnect/events", status_code=status.HTTP_202_ACCEPTED)
async def wppconnect_event(request: Request) -> dict[str, Any]:
    body = await request.body()
    if len(body) > MAX_WPP_BODY_BYTES:
        raise HTTPException(status_code=413, detail="WPPConnect webhook body too large")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="malformed WPPConnect JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="WPPConnect webhook must be an object")

    try:
        event = normalize_wppconnect_event(
            payload,
            allowed_sessions=request.app.state.allowed_sessions,
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if event is None:
        return {"status": "IGNORED"}

    outbox: SQLiteBridgeOutbox = request.app.state.outbox
    created = await asyncio.to_thread(outbox.enqueue, event)
    return {
        "status": "QUEUED" if created else "DUPLICATE",
        "source_event_id": event.source_event_id,
    }
