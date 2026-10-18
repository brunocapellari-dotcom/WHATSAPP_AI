"""Authenticated HTTP ingress must persist every reportable freight line."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from datetime import UTC, datetime

from fastapi.testclient import TestClient

from app import main as ingress
from app.models import RawInboundEvent
from app.storage import InMemoryFreightStore


def _post(client: TestClient, event: RawInboundEvent, provider: str, secret: str):
    body = event.model_dump_json().encode("utf-8")
    timestamp = str(int(time.time()))
    digest = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    return client.post(
        f"/v1/providers/{provider}/events",
        content=body,
        headers={
            "content-type": "application/json",
            "x-tenant-id": "tenant-a",
            "x-webhook-timestamp": timestamp,
            "x-webhook-signature": "sha256=" + digest,
        },
    )


def test_authenticated_webhook_persists_multiple_lines_without_provider_collision(
    monkeypatch,
) -> None:
    store = InMemoryFreightStore()
    cities = {
        "SORRISO": ("Sorriso", "MT", "5107925"),
        "SINOP": ("Sinop", "MT", "5107909"),
        "RONDONÓPOLIS": ("Rondonópolis", "MT", "5107602"),
    }
    store.resolve_municipality = lambda city: cities.get(city.upper())  # type: ignore[attr-defined]
    monkeypatch.setattr(ingress, "_store", lambda: store)
    monkeypatch.setenv(
        "WHATSAPP_WEBHOOK_SECRETS",
        json.dumps({"tenant-a:bridge-a": "a-secret", "tenant-a:bridge-b": "b-secret"}),
    )
    event = RawInboundEvent(
        source_event_id="provider-message-1",
        source="authorized-test-chat",
        message_timestamp=datetime(2026, 10, 18, 11, tzinfo=UTC),
        raw_text=(
            "RODOVIVA TRANSPORTES\nSOJA R$/T\nDESTINO: RONDONÓPOLIS\n"
            "SORRISO - FAZENDA BOA VISTA R$ 180,00 /T\n"
            "SINOP - FAZENDA BOA TARDE R$ 190,00 /T"
        ),
    )
    with TestClient(ingress.app) as client:
        first = _post(client, event, "bridge-a", "a-secret")
        assert first.status_code == 202, first.text
        assert len(store.report_observations) == 2
        original_ids = set(store.report_observations)

        duplicate = _post(client, event, "bridge-a", "a-secret")
        assert duplicate.status_code == 202
        assert duplicate.json()["status"] == "DUPLICATE_SOURCE_EVENT"
        assert set(store.report_observations) == original_ids

        second_provider = _post(client, event, "bridge-b", "b-secret")
        assert second_provider.status_code == 202, second_provider.text
        assert len(store.report_observations) == 4
        assert all(
            observation.source_event_id == "provider-message-1"
            for observation in store.report_observations.values()
        )
