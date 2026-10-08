from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime

import pytest

from app import integration
from app.integration import AgroLogClient
from app.models import FreightClassification, FreightEvent
from app.security import SecurityError
from app.storage import PostgresFreightStore


class FakeResponse:
    def raise_for_status(self) -> None:
        return None


def event() -> FreightEvent:
    return FreightEvent(
        tenant_id="tenant-a",
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=["source-1"],
        raw_reference="raw://source-1",
        timestamp=datetime(2026, 10, 8, 12, 0, tzinfo=UTC),
        product="SOJA",
        confidence=0.9,
    )


def test_private_agrolog_request_uses_oidc_hmac_and_idempotency(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def fake_post(url, *, content, headers, timeout):
        captured.update(
            {
                "url": url,
                "content": content,
                "headers": headers,
                "timeout": timeout,
            }
        )
        return FakeResponse()

    monkeypatch.setattr(integration, "_fetch_identity_token", lambda audience: "oidc-token")
    monkeypatch.setattr(integration.httpx, "post", fake_post)
    monkeypatch.setattr(integration.time, "time", lambda: 1000)

    client = AgroLogClient(
        endpoint="https://agrolog.example.com/v1/freight/events",
        shared_secret="shared-secret",
        allowed_hosts={"agrolog.example.com"},
        oidc_audience="https://agrolog.example.com",
    )
    freight = event()
    client.send(freight)

    headers = captured["headers"]
    body = captured["content"]
    assert headers["authorization"] == "Bearer oidc-token"
    assert headers["x-idempotency-key"] == f"{freight.event_id}:{freight.version}"
    expected = hmac.new(
        b"shared-secret",
        b"1000." + body,
        hashlib.sha256,
    ).hexdigest()
    assert headers["x-agrolog-signature"] == f"sha256={expected}"


def test_from_env_rejects_oidc_audience_on_another_host(monkeypatch) -> None:
    monkeypatch.setenv(
        "AGROLOG_FREIGHT_INGEST_URL",
        "https://agrolog.example.com/v1/freight/events",
    )
    monkeypatch.setenv("AGROLOG_SHARED_SECRET", "shared-secret")
    monkeypatch.setenv("AGROLOG_EGRESS_ALLOWED_HOSTS", "agrolog.example.com")
    monkeypatch.setenv("AGROLOG_OIDC_AUDIENCE", "https://evil.example.com")

    with pytest.raises(SecurityError, match="audience host"):
        AgroLogClient.from_env()


def test_worker_store_does_not_require_raw_encryption_secret(monkeypatch) -> None:
    monkeypatch.setenv(
        "DATABASE_URL_WORKER",
        "postgresql://worker:password@127.0.0.1:5432/db",
    )
    monkeypatch.delenv("WHATSAPP_RAW_ENCRYPTION_KEY_B64", raising=False)

    store = PostgresFreightStore.from_env(worker=True)

    assert store.worker_mode is True
    assert store.cipher is None


def test_ingress_store_still_requires_raw_encryption_secret(monkeypatch) -> None:
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://ingestor:password@127.0.0.1:5432/db",
    )
    monkeypatch.delenv("WHATSAPP_RAW_ENCRYPTION_KEY_B64", raising=False)

    with pytest.raises(RuntimeError, match="WHATSAPP_RAW_ENCRYPTION_KEY_B64"):
        PostgresFreightStore.from_env()
