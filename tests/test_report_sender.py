"""Report transport is disabled without consent and fail-closed on uncertain sends."""
from datetime import UTC, datetime
from hashlib import sha256

import httpx
import pytest

from app.report_sender import (
    DeliveryAmbiguous,
    SendPart,
    WppReportTransport,
    _message_id,
    validate_destination,
    validate_wpp_origin,
)


@pytest.mark.parametrize("value", ["", "123@g.us", "+5511999999999", "55 11 999999999", "0" * 11])
def test_unapproved_phone_formats_cannot_be_sent(value: str) -> None:
    with pytest.raises(ValueError):
        validate_destination(value)


def test_direct_international_number_allowed() -> None:
    assert validate_destination("5566999999999") == "5566999999999"


@pytest.mark.parametrize("origin", [
    "http://wppconnect:21466",
    "http://127.0.0.1:21465",
    "https://evil.example",
    "http://user:password@wppconnect:21465",
    "http://wppconnect:21465/redirect",
    "http://wppconnect:21465/?secret=1",
])
def test_wpp_sender_rejects_other_origins(origin: str) -> None:
    with pytest.raises(ValueError):
        validate_wpp_origin(origin, "authorized-session", "x" * 40)


def test_ambiguous_provider_reply_is_not_an_ack() -> None:
    with pytest.raises(DeliveryAmbiguous):
        _message_id({"status": "success"})
    with pytest.raises(DeliveryAmbiguous):
        _message_id({"status": "error", "response": {"id": "123"}})
    assert _message_id({"status": "success", "response": {"id": "message-123"}}) == "message-123"


def test_unauthorized_number_blocks_before_network(monkeypatch) -> None:
    sender = WppReportTransport("http://wppconnect:21465", "session", "x" * 40)
    task = SendPart(1, "TEXT", "group@g.us", "report", None, datetime.now(UTC))
    monkeypatch.setattr(httpx, "Client", lambda **kw: pytest.fail("no network expected"))
    with pytest.raises(ValueError, match="recipient"):
        sender.send(task)


def test_report_message_ack_requires_message_id(monkeypatch) -> None:
    sent = []
    class FakeResponse:
        status_code = 200
        def json(self):
            return {"status": "success", "response": {"id": "message-1"}}

    class FakeClient:
        def __init__(self, **kwargs):
            assert kwargs["trust_env"] is False
            assert kwargs["follow_redirects"] is False
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def post(self, url, *, json, headers):
            sent.append((url, json, headers))
            return FakeResponse()

    monkeypatch.setattr(httpx, "Client", FakeClient)
    sender = WppReportTransport("http://wppconnect:21465", "session", "x" * 40)
    task = SendPart(5, "TEXT", "5566999999999", "fretes", None, datetime.now(UTC))
    assert sender.send(task) == "message-1"
    assert len(sent) == 1
    assert sent[0][0].endswith("/api/session/send-message")
    assert sent[0][1]["isGroup"] is False
    assert sent[0][1]["message"] == "fretes"


def test_artifact_hash_mismatch_blocks_network(monkeypatch) -> None:
    monkeypatch.setattr(httpx, "Client", lambda **kw: pytest.fail("no network expected"))
    sender = WppReportTransport("http://wppconnect:21465", "session", "x" * 40)
    pdf = b"%PDF" + b"x" * 600
    assert sha256(pdf).hexdigest() != "0" * 64
    task = SendPart(1, "PDF", "5566999999999", pdf, "0" * 64, datetime.now(UTC))
    with pytest.raises(ValueError, match="digest"):
        sender.send(task)


def test_external_sender_requires_manual_opt_in(monkeypatch) -> None:
    from app import report_sender
    monkeypatch.delenv("REPORT_SENDER_ENABLED", raising=False)
    with pytest.raises(RuntimeError, match="REPORT_SENDER_ENABLED"):
        report_sender.main()
