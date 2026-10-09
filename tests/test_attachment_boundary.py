from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi import HTTPException

from app.main import _validate_attachments
from app.models import RawInboundEvent


def event(attachment: dict) -> RawInboundEvent:
    return RawInboundEvent(
        source_event_id="m1",
        source="fixture",
        message_timestamp=datetime(2026, 10, 8, 12, 0, tzinfo=UTC),
        raw_text="FRETE SOJA ORIGEM A DESTINO B",
        raw_event={"fixture": True},
        attachments=[attachment],
    )


def test_metadata_only_attachment_is_allowed() -> None:
    raw = event(
        {
            "attachment_id": "a1",
            "filename": "offer.jpg",
            "mime_type": "image/jpeg",
            "size_bytes": 1234,
            "content_hash": "a" * 64,
        }
    )
    _validate_attachments(raw)


def test_byte_or_url_reference_is_rejected_until_scanner_exists() -> None:
    raw = event(
        {
            "attachment_id": "a1",
            "filename": "offer.pdf",
            "mime_type": "application/pdf",
            "storage_reference": "https://example.com/file.pdf",
        }
    )
    with pytest.raises(HTTPException) as exc:
        _validate_attachments(raw)
    assert exc.value.status_code == 422


def test_non_sha256_hash_is_rejected() -> None:
    raw = event(
        {
            "attachment_id": "a1",
            "mime_type": "image/jpeg",
            "content_hash": "not-a-sha256",
        }
    )
    with pytest.raises(HTTPException) as exc:
        _validate_attachments(raw)
    assert exc.value.status_code == 422


def test_disallowed_mime_is_rejected_before_any_processing() -> None:
    raw = event(
        {
            "attachment_id": "a1",
            "filename": "payload.bin",
            "mime_type": "application/octet-stream",
        }
    )
    with pytest.raises(HTTPException) as exc:
        _validate_attachments(raw)
    assert exc.value.status_code == 415
