"""Explicit opt-in WhatsApp report sender.

Each TEXT/PDF/XLSX message is acknowledged separately in PostgreSQL.
Uncertain provider results or expired claims require manual reconciliation;
they are never automatically retried because WPPConnect has no contractual
cross-request idempotency guarantee.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx
import psycopg

logger = logging.getLogger("whatsapp_ai.report_sender")
PHONE_RE = re.compile(r"^[1-9][0-9]{7,14}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class DeliveryAmbiguous(RuntimeError):
    """The provider might have accepted this request: do not retry."""


@dataclass(frozen=True)
class SendPart:
    delivery_id: int
    part_kind: str
    destination: str
    body: str | bytes
    expected_sha256: str | None
    cutoff: datetime


def validate_destination(destination: str) -> str:
    """Only directly authorized international phone numbers, never groups."""
    if not PHONE_RE.fullmatch(destination):
        raise ValueError("recipient must be 8-15 digits with country code")
    return destination


def validate_wpp_origin(origin: str, session: str, token: str) -> str:
    parsed = urlparse(origin)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "wppconnect"
        or parsed.port != 21465
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or parsed.username
        or parsed.password
    ):
        raise ValueError("sender requires the private wppconnect:21465 service")
    if not SESSION_RE.fullmatch(session):
        raise ValueError("invalid WPPConnect session name")
    if len(token) < 32 or any(c.isspace() for c in token):
        raise ValueError("WPPConnect bearer token is missing or invalid")
    return origin.rstrip("/")


def _message_id(payload: object) -> str:
    """Require a provider message ID; HTTP 2xx alone does not prove delivery."""
    if not isinstance(payload, dict) or payload.get("status") in {"error", "failed"}:
        raise DeliveryAmbiguous("provider returned no successful message acknowledgment")
    response = payload.get("response")
    if not isinstance(response, dict):
        raise DeliveryAmbiguous("provider returned no message object")
    message_id = response.get("id")
    if isinstance(message_id, dict):
        message_id = message_id.get("_serialized")
    if not isinstance(message_id, str) or not message_id or len(message_id) > 512:
        raise DeliveryAmbiguous("provider did not return a usable message ID")
    return message_id


class WppReportTransport:
    def __init__(self, origin: str, session: str, token: str) -> None:
        self.origin = validate_wpp_origin(origin, session, token)
        self.session = session
        self.token = token

    def send(self, part: SendPart) -> str:
        destination = validate_destination(part.destination)
        headers = {"Authorization": "Bearer " + self.token}
        base = {"phone": destination, "isGroup": False, "isNewsletter": False, "isLid": False}
        if part.part_kind == "TEXT":
            if not isinstance(part.body, str) or not 1 <= len(part.body) <= 45000:
                raise ValueError("report text is missing or too large")
            endpoint = "send-message"
            payload = {**base, "message": part.body}
        elif part.part_kind in {"PDF", "XLSX"}:
            if not isinstance(part.body, bytes) or not 500 <= len(part.body) <= 10_000_000:
                raise ValueError("report file is missing or exceeds 10 MB")
            expected = part.expected_sha256
            if not expected or hashlib.sha256(part.body).hexdigest() != expected:
                raise ValueError("report artifact digest mismatch")
            ext = part.part_kind.lower()
            mime = (
                "application/pdf" if part.part_kind == "PDF"
                else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            )
            filename = f"fretes-{part.cutoff:%Y%m%d-%H%M}-{ext}.{ext}"
            endpoint = "send-file-base64"
            payload = {
                **base,
                "filename": filename,
                "caption": "Relatório de fretes",
                "base64": "data:" + mime + ";base64," + base64.b64encode(part.body).decode("ascii"),
            }
        else:
            raise ValueError("unsupported report part")
        try:
            with httpx.Client(timeout=15.0, trust_env=False, follow_redirects=False) as client:
                response = client.post(
                    f"{self.origin}/api/{self.session}/{endpoint}", json=payload, headers=headers
                )
            if response.status_code not in {200, 201}:
                raise DeliveryAmbiguous("provider HTTP status did not prove non-delivery")
            return _message_id(response.json())
        except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
            raise DeliveryAmbiguous("provider response is not a verified acknowledgment") from exc


class ReportSendRepository:
    def __init__(self, database_url: str, tenant_id: str) -> None:
        if not tenant_id.strip():
            raise ValueError("tenant required")
        self.database_url = database_url
        self.tenant_id = tenant_id

    def _set_tenant(self, cur: psycopg.Cursor) -> None:
        cur.execute("SELECT set_config('app.tenant_id', %s, true)", (self.tenant_id,))

    def flag_expired_claims(self, *, older_than_seconds: int = 300) -> int:
        """A crashed sender may have sent a message: never blindly replay it."""
        if older_than_seconds < 60:
            raise ValueError("claim timeout too small")
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur)
            cur.execute(
                """UPDATE whatsapp_report_delivery_parts p
                   SET status='REVIEW_REQUIRED'
                   FROM whatsapp_report_delivery_outbox d
                   WHERE p.tenant_id=%s AND p.tenant_id=d.tenant_id
                     AND p.delivery_id=d.delivery_id AND p.status='CLAIMED'
                     AND p.claimed_at < now() - (%s * interval '1 second')
                   RETURNING d.delivery_id""",
                (self.tenant_id, older_than_seconds),
            )
            deliveries = {int(row[0]) for row in cur.fetchall()}
            if deliveries:
                cur.execute(
                    """UPDATE whatsapp_report_delivery_outbox SET
                       status='DEAD', last_error='manual_review_required'
                       WHERE tenant_id=%s AND delivery_id = ANY(%s)""",
                    (self.tenant_id, sorted(deliveries)),
                )
            conn.commit()
            return len(deliveries)

    def claim_next(self) -> SendPart | None:
        """Claim exactly one part under row locks, rechecking consent and health."""
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur)
            cur.execute(
                """SELECT d.delivery_id
                   FROM whatsapp_report_delivery_outbox d
                   JOIN whatsapp_report_recipients r
                     ON (r.tenant_id=d.tenant_id AND r.recipient_id=d.recipient_id)
                   JOIN whatsapp_freight_report_snapshots s
                     ON (s.tenant_id=d.tenant_id AND s.cutoff_at=d.cutoff_at
                         AND s.report_kind=d.report_kind)
                   WHERE d.tenant_id=%s AND d.status='PENDING'
                     AND d.next_attempt_at<=now() AND r.transport='WHATSAPP'
                     AND r.authorized AND r.authorized_at IS NOT NULL
                     AND s.status='READY' AND s.collector_healthy
                   ORDER BY d.delivery_id FOR UPDATE OF d SKIP LOCKED LIMIT 1""",
                (self.tenant_id,),
            )
            row = cur.fetchone()
            if row is not None:
                delivery_id = int(row[0])
                cur.execute(
                    """UPDATE whatsapp_report_delivery_outbox
                       SET status='PROCESSING', claimed_at=now()
                       WHERE tenant_id=%s AND delivery_id=%s""",
                    (self.tenant_id, delivery_id),
                )
                cur.executemany(
                    """INSERT INTO whatsapp_report_delivery_parts
                       (tenant_id, delivery_id, part_kind)
                       VALUES (%s,%s,%s) ON CONFLICT DO NOTHING""",
                    [(self.tenant_id, delivery_id, part) for part in ("TEXT", "PDF", "XLSX")],
                )

            cur.execute(
                """SELECT p.delivery_id, p.part_kind, r.destination,
                          s.rendered_markdown, s.pdf_data, s.xlsx_data,
                          s.pdf_sha256, s.xlsx_sha256, d.cutoff_at
                   FROM whatsapp_report_delivery_parts p
                   JOIN whatsapp_report_delivery_outbox d
                     ON (d.tenant_id=p.tenant_id AND d.delivery_id=p.delivery_id)
                   JOIN whatsapp_report_recipients r
                     ON (r.tenant_id=d.tenant_id AND r.recipient_id=d.recipient_id)
                   JOIN whatsapp_freight_report_snapshots s
                     ON (s.tenant_id=d.tenant_id AND s.cutoff_at=d.cutoff_at
                         AND s.report_kind=d.report_kind)
                   WHERE p.tenant_id=%s AND p.status='PENDING'
                     AND d.status='PROCESSING'
                     AND r.transport='WHATSAPP' AND r.authorized
                     AND r.authorized_at IS NOT NULL
                     AND s.status='READY' AND s.collector_healthy
                     AND NOT EXISTS (
                       SELECT 1 FROM whatsapp_report_delivery_parts earlier
                       WHERE earlier.tenant_id=p.tenant_id
                         AND earlier.delivery_id=p.delivery_id
                         AND (
                           earlier.status IN ('CLAIMED','REVIEW_REQUIRED')
                           OR (
                             earlier.status='PENDING' AND
                             CASE earlier.part_kind
                               WHEN 'TEXT' THEN 1 WHEN 'PDF' THEN 2 ELSE 3 END
                             < CASE p.part_kind
                               WHEN 'TEXT' THEN 1 WHEN 'PDF' THEN 2 ELSE 3 END
                           )
                         )
                     )
                   ORDER BY p.delivery_id,
                     CASE p.part_kind WHEN 'TEXT' THEN 1 WHEN 'PDF' THEN 2 ELSE 3 END
                   FOR UPDATE OF d SKIP LOCKED LIMIT 1""",
                (self.tenant_id,),
            )
            row = cur.fetchone()
            if row is None:
                conn.commit()
                return None
            delivery_id = int(row[0])
            kind = str(row[1])
            if kind == "TEXT":
                body: str | bytes = str(row[3] or "")
            else:
                artifact = row[4] if kind == "PDF" else row[5]
                body = bytes(artifact) if artifact is not None else b""
            expected = str(row[6] if kind == "PDF" else row[7]) if kind != "TEXT" else None
            cur.execute(
                """UPDATE whatsapp_report_delivery_parts SET
                   status='CLAIMED', claimed_at=now()
                   WHERE tenant_id=%s AND delivery_id=%s
                   AND part_kind=%s AND status='PENDING'""",
                (self.tenant_id, delivery_id, kind),
            )
            conn.commit()
            return SendPart(delivery_id, kind, str(row[2]), body, expected, row[8])

    def conclude(self, part: SendPart, *, message_id: str | None) -> None:
        with psycopg.connect(self.database_url) as conn, conn.cursor() as cur:
            self._set_tenant(cur)
            cur.execute(
                """UPDATE whatsapp_report_delivery_parts SET
                   status=%s, acknowledged_at=%s, provider_message_id=%s
                   WHERE tenant_id=%s AND delivery_id=%s AND part_kind=%s
                     AND status='CLAIMED'""",
                (
                    "ACKNOWLEDGED" if message_id else "REVIEW_REQUIRED",
                    datetime.now(UTC) if message_id else None, message_id,
                    self.tenant_id, part.delivery_id, part.part_kind,
                ),
            )
            if cur.rowcount != 1:
                raise RuntimeError("delivery claim disappeared")
            if message_id is None:
                cur.execute(
                    """UPDATE whatsapp_report_delivery_outbox SET
                       status='DEAD', last_error='manual_review_required'
                       WHERE tenant_id=%s AND delivery_id=%s""",
                    (self.tenant_id, part.delivery_id),
                )
            else:
                cur.execute(
                    """UPDATE whatsapp_report_delivery_outbox d SET
                       status='SENT', delivered_at=now(), last_error=NULL
                       WHERE d.tenant_id=%s AND d.delivery_id=%s
                         AND NOT EXISTS (
                           SELECT 1 FROM whatsapp_report_delivery_parts p
                           WHERE p.tenant_id=d.tenant_id AND p.delivery_id=d.delivery_id
                             AND p.status!='ACKNOWLEDGED'
                         )""",
                    (self.tenant_id, part.delivery_id),
                )
            conn.commit()


def main() -> int:
    """This process cannot start without a deliberate opt-in and private token."""
    if os.environ.get("REPORT_SENDER_ENABLED") != "1":
        raise RuntimeError("REPORT_SENDER_ENABLED=1 is required for external sends")
    def required(key: str) -> str:
        value = os.environ.get(key, "").strip()
        if not value:
            raise RuntimeError(f"{key} is required")
        return value

    store = ReportSendRepository(
        required("DATABASE_URL_REPORTER"), required("WHATSAPP_REPORT_TENANT_ID")
    )
    transport = WppReportTransport(
        required("WPP_REPORT_ORIGIN"), required("WPP_SESSION_NAME"),
        required("WPP_REPORT_BEARER_TOKEN"),
    )
    while True:
        try:
            store.flag_expired_claims()
            part = store.claim_next()
            if part is None:
                time.sleep(10)
                continue
            try:
                message_id = transport.send(part)
            except (DeliveryAmbiguous, ValueError):
                store.conclude(part, message_id=None)
                logger.error("report_delivery_manual_review delivery_id=%s kind=%s", part.delivery_id, part.part_kind)
            else:
                store.conclude(part, message_id=message_id)
                logger.info("report_delivery_acknowledged delivery_id=%s kind=%s", part.delivery_id, part.part_kind)
        except (psycopg.Error, OSError, RuntimeError) as exc:
            logger.error("report_sender_error error_type=%s", type(exc).__name__)
            time.sleep(30)


if __name__ == "__main__":
    raise SystemExit(main())
