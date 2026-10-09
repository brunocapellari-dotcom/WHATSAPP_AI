from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path

import httpx
import pytest

import app.provider_bridge as bridge
from app.provider_bridge import (
    BridgeCipher,
    BridgeConfigError,
    BridgeDispatcher,
    SQLiteBridgeOutbox,
    normalize_wppconnect_event,
)
from app.security import SecurityError


def wpp_payload(**overrides):
    payload = {
        "event": "onmessage",
        "session": "freight-prod",
        "id": "3EB0ABC123",
        "body": "FRETE SOJA ORIGEM: Lucas do Rio Verde DESTINO: Rondonópolis R$ 155",
        "type": "chat",
        "timestamp": int(time.time()),
        "from": "556599999999@c.us",
        "to": "556588888888@c.us",
        "author": None,
        "notifyName": "Transportadora",
        "isGroupMsg": False,
        "isMedia": False,
        "isMMS": False,
        "fromMe": False,
    }
    payload.update(overrides)
    return payload


def test_normalize_wppconnect_text_message() -> None:
    event = normalize_wppconnect_event(
        wpp_payload(),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    assert event.source_event_id == "freight-prod:3EB0ABC123"
    assert event.raw_text.startswith("FRETE SOJA")
    assert event.metadata["provider_message_id"] == "3EB0ABC123"
    assert event.metadata["media_bytes_accepted"] is False
    assert event.attachments == []


def test_non_message_and_self_message_are_ignored() -> None:
    assert (
        normalize_wppconnect_event(
            wpp_payload(event="status-find"),
            allowed_sessions={"freight-prod"},
        )
        is None
    )
    assert (
        normalize_wppconnect_event(
            wpp_payload(fromMe=True),
            allowed_sessions={"freight-prod"},
        )
        is None
    )


def test_unapproved_session_is_rejected() -> None:
    with pytest.raises(ValueError, match="allowlisted"):
        normalize_wppconnect_event(
            wpp_payload(session="other"),
            allowed_sessions={"freight-prod"},
        )


def test_media_bytes_are_redacted_and_never_become_attachment_reference() -> None:
    encoded_media = "A" * 9000
    event = normalize_wppconnect_event(
        wpp_payload(
            isMedia=True,
            mimetype="image/jpeg",
            body=encoded_media,
            caption="FRETE SOJA ORIGEM A DESTINO B",
            filehash="provider-base64-hash",
            size=12345,
        ),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    assert event.raw_text == "FRETE SOJA ORIGEM A DESTINO B"
    assert event.attachments[0].storage_reference is None
    assert event.attachments[0].content_hash is None
    assert event.raw_event["body"] == "[MEDIA_BYTES_REDACTED]"
    assert encoded_media not in json.dumps(event.raw_event)


def test_quoted_message_becomes_namespaced_reply_reference() -> None:
    event = normalize_wppconnect_event(
        wpp_payload(quotedMsgId="3EB0OLDER"),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    assert event.metadata["reply_to_source_event_id"] == "freight-prod:3EB0OLDER"


def test_encrypted_sqlite_outbox_is_durable_and_deduplicated(tmp_path: Path) -> None:
    event = normalize_wppconnect_event(
        wpp_payload(body="SENSITIVE FREIGHT TEXT"),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    db_path = tmp_path / "outbox.sqlite3"
    outbox = SQLiteBridgeOutbox(
        str(db_path),
        BridgeCipher(b"0" * 32),
    )
    outbox.ensure_schema()
    assert outbox.enqueue(event) is True
    assert outbox.enqueue(event) is False

    raw_file = db_path.read_bytes()
    assert b"SENSITIVE FREIGHT TEXT" not in raw_file

    claimed = outbox.claim()
    assert len(claimed) == 1
    assert claimed[0][1].raw_text == "SENSITIVE FREIGHT TEXT"


def test_corrupted_encrypted_payload_moves_to_dead(tmp_path: Path) -> None:
    event = normalize_wppconnect_event(
        wpp_payload(),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    outbox = SQLiteBridgeOutbox(
        str(tmp_path / "outbox.sqlite3"),
        BridgeCipher(b"1" * 32),
    )
    outbox.ensure_schema()
    outbox.enqueue(event)

    with outbox._connect() as conn:
        conn.execute(
            "UPDATE provider_outbox SET ciphertext=? WHERE source_event_id=?",
            (b"corrupted", event.source_event_id),
        )

    assert outbox.claim() == []
    assert outbox.status_counts()["DEAD"] == 1


def test_dispatcher_signs_exact_bytes_and_marks_sent(tmp_path: Path, monkeypatch) -> None:
    event = normalize_wppconnect_event(
        wpp_payload(),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    outbox = SQLiteBridgeOutbox(
        str(tmp_path / "outbox.sqlite3"),
        BridgeCipher(b"2" * 32),
    )
    outbox.ensure_schema()
    outbox.enqueue(event)
    captured = {}

    def fake_post(url, *, content, headers, timeout):
        captured.update(
            {"url": url, "content": content, "headers": headers, "timeout": timeout}
        )
        return httpx.Response(202)

    monkeypatch.setattr(bridge.httpx, "post", fake_post)
    monkeypatch.setattr(bridge.time, "time", lambda: 1000)

    dispatcher = BridgeDispatcher(
        outbox,
        endpoint="https://hooks.example.com/v1/providers/wppconnect/events",
        tenant_id="freight-prod",
        provider="wppconnect",
        hmac_secret="shared-secret",
        allowed_hosts={"hooks.example.com"},
    )
    assert dispatcher.flush() == {"sent": 1, "failed": 0}
    headers = captured["headers"]
    body = captured["content"]
    expected = hmac.new(
        b"shared-secret",
        b"1000." + body,
        hashlib.sha256,
    ).hexdigest()
    assert headers["x-tenant-id"] == "freight-prod"
    assert headers["x-webhook-signature"] == f"sha256={expected}"
    assert outbox.status_counts()["SENT"] == 1


def test_permanent_cloud_rejection_goes_dead(tmp_path: Path, monkeypatch) -> None:
    event = normalize_wppconnect_event(
        wpp_payload(),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    outbox = SQLiteBridgeOutbox(
        str(tmp_path / "outbox.sqlite3"),
        BridgeCipher(b"3" * 32),
    )
    outbox.ensure_schema()
    outbox.enqueue(event)

    monkeypatch.setattr(
        bridge.httpx,
        "post",
        lambda *args, **kwargs: httpx.Response(422),
    )
    dispatcher = BridgeDispatcher(
        outbox,
        endpoint="https://hooks.example.com/v1/providers/wppconnect/events",
        tenant_id="freight-prod",
        provider="wppconnect",
        hmac_secret="shared-secret",
        allowed_hosts={"hooks.example.com"},
    )
    assert dispatcher.flush() == {"sent": 0, "failed": 1}
    assert outbox.status_counts()["DEAD"] == 1


def test_target_path_and_host_are_fail_closed(tmp_path: Path) -> None:
    outbox = SQLiteBridgeOutbox(
        str(tmp_path / "outbox.sqlite3"),
        BridgeCipher(b"4" * 32),
    )
    outbox.ensure_schema()
    with pytest.raises(BridgeConfigError, match="path"):
        BridgeDispatcher(
            outbox,
            endpoint="https://hooks.example.com/not-the-provider-path",
            tenant_id="freight-prod",
            provider="wppconnect",
            hmac_secret="shared-secret",
            allowed_hosts={"hooks.example.com"},
        )
    with pytest.raises(SecurityError):
        BridgeDispatcher(
            outbox,
            endpoint="https://evil.example.com/v1/providers/wppconnect/events",
            tenant_id="freight-prod",
            provider="wppconnect",
            hmac_secret="shared-secret",
            allowed_hosts={"hooks.example.com"},
        )



def test_oversized_sanitized_event_is_reduced_with_integrity_hash() -> None:
    huge = "x" * 710_000
    event = normalize_wppconnect_event(
        wpp_payload(extra_blob=huge),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    assert event.raw_event["_raw_event_truncated"] is True
    assert event.raw_event["_raw_event_original_size_bytes"] > 700_000
    assert len(event.raw_event["_raw_event_sha256"]) == 64
    assert "extra_blob" not in event.raw_event


def test_sent_records_can_be_pruned_without_touching_dead(tmp_path: Path, monkeypatch) -> None:
    event = normalize_wppconnect_event(
        wpp_payload(),
        allowed_sessions={"freight-prod"},
    )
    assert event is not None
    outbox = SQLiteBridgeOutbox(
        str(tmp_path / "outbox.sqlite3"),
        BridgeCipher(b"5" * 32),
    )
    outbox.ensure_schema()
    outbox.enqueue(event)
    claimed = outbox.claim()
    assert len(claimed) == 1
    outbox.mark_sent(claimed[0][0])

    monkeypatch.setattr(bridge.time, "time", lambda: time.time() + 700_000)
    assert outbox.prune_sent(604800) == 1
    assert outbox.status_counts()["SENT"] == 0
