from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime

from app.integration import AgroLogClient
from app.models import FreightClassification, FreightEvent


class FakeResponse:
    def raise_for_status(self) -> None:
        return None


def _event() -> FreightEvent:
    return FreightEvent(
        tenant_id="tenant-a",
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=["source-1"],
        raw_reference="raw://source-1",
        timestamp=datetime(2026, 10, 7, 12, 0, tzinfo=UTC),
        product="SOJA",
        confidence=0.9,
    )


def test_private_agrolog_delivery_uses_id_token_and_hmac(monkeypatch) -> None:
    captured: dict = {}

    monkeypatch.setattr(
        "app.integration.id_token.fetch_id_token",
        lambda request, audience: "signed-id-token",
    )

    def fake_post(endpoint, *, content, headers, timeout):
        captured.update(
            {
                "endpoint": endpoint,
                "content": content,
                "headers": headers,
                "timeout": timeout,
            }
        )
        return FakeResponse()

    monkeypatch.setattr("app.integration.httpx.post", fake_post)
    monkeypatch.setattr("app.integration.time.time", lambda: 1000)

    client = AgroLogClient(
        endpoint="https://agrolog.example.com/v1/freight/events",
        shared_secret="shared-secret",
        allowed_hosts={"agrolog.example.com"},
        id_token_audience="https://agrolog.example.com",
    )
    event = _event()
    client.send(event)

    assert captured["headers"]["authorization"] == "Bearer signed-id-token"
    assert captured["headers"]["x-idempotency-key"] == f"{event.event_id}:1"
    expected = hmac.new(
        b"shared-secret",
        b"1000." + captured["content"],
        hashlib.sha256,
    ).hexdigest()
    assert captured["headers"]["x-agrolog-signature"] == f"sha256={expected}"


def test_id_token_is_optional_for_local_contract_tests(monkeypatch) -> None:
    captured: dict = {}

    def fake_post(endpoint, *, content, headers, timeout):
        captured["headers"] = headers
        return FakeResponse()

    monkeypatch.setattr("app.integration.httpx.post", fake_post)
    client = AgroLogClient(
        endpoint="https://agrolog.example.com/v1/freight/events",
        shared_secret="shared-secret",
        allowed_hosts={"agrolog.example.com"},
    )
    client.send(_event())

    assert "authorization" not in captured["headers"]
