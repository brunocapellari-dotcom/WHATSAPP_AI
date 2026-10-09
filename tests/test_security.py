from __future__ import annotations

import hashlib
import hmac

import pytest
from fastapi import HTTPException

from app.main import _validate_security_identifier
from app.security import SecurityError, validate_egress_url, verify_webhook_signature


def signature(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def test_valid_signature() -> None:
    body = b'{"ok":true}'
    verify_webhook_signature(body, timestamp="1000", signature=signature("s", "1000", body), secret="s", now_epoch=1000)


def test_replay_is_rejected() -> None:
    body = b"{}"
    with pytest.raises(SecurityError, match="replay"):
        verify_webhook_signature(body, timestamp="1000", signature=signature("s", "1000", body), secret="s", now_epoch=1400)


def test_bad_signature_is_rejected() -> None:
    with pytest.raises(SecurityError):
        verify_webhook_signature(b"{}", timestamp="1000", signature="sha256=bad", secret="s", now_epoch=1000)


def test_egress_allowlist_blocks_ssrf_destination() -> None:
    with pytest.raises(SecurityError):
        validate_egress_url("http://169.254.169.254/latest/meta-data", {"agrolog.example.com"})
    with pytest.raises(SecurityError):
        validate_egress_url("https://evil.example.com/ingest", {"agrolog.example.com"})
    assert validate_egress_url("https://agrolog.example.com/v1/freight/events", {"agrolog.example.com"})



@pytest.mark.parametrize(
    "value,kind",
    [
        ("tenant:other", "tenant"),
        ("tenant/other", "tenant"),
        (" provider", "provider"),
        ("provider?", "provider"),
        ("a" * 65, "provider"),
    ],
)
def test_security_identifiers_reject_ambiguous_or_unsafe_values(value: str, kind: str) -> None:
    with pytest.raises(HTTPException):
        _validate_security_identifier(value, kind=kind)


def test_security_identifiers_accept_canonical_values() -> None:
    assert _validate_security_identifier("tenant-01", kind="tenant") == "tenant-01"
    assert _validate_security_identifier("wppconnect.prod", kind="provider") == "wppconnect.prod"
