from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass

import httpx
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request
from google.oauth2 import id_token

from .models import FreightEvent
from .security import SecurityError, validate_egress_url, validate_oidc_audience


class DeliveryError(RuntimeError):
    """Retryable or terminal delivery failure at the AgroLog boundary."""


def _fetch_identity_token(audience: str) -> str:
    return id_token.fetch_id_token(Request(), audience)


@dataclass(frozen=True)
class AgroLogClient:
    endpoint: str
    shared_secret: str
    allowed_hosts: set[str]
    oidc_audience: str | None = None
    timeout_seconds: float = 10.0

    @classmethod
    def from_env(cls) -> AgroLogClient:
        endpoint = os.environ["AGROLOG_FREIGHT_INGEST_URL"]
        secret = os.environ["AGROLOG_SHARED_SECRET"]
        hosts = {item.strip() for item in os.environ.get("AGROLOG_EGRESS_ALLOWED_HOSTS", "").split(",") if item.strip()}
        allow_private_http = os.environ.get("AGROLOG_ALLOW_PRIVATE_HTTP", "0") == "1"
        validate_egress_url(
            endpoint,
            hosts,
            allow_private_http=allow_private_http,
        )
        audience = os.environ.get("AGROLOG_OIDC_AUDIENCE")
        if audience:
            audience = validate_oidc_audience(endpoint, audience)
        return cls(
            endpoint=endpoint,
            shared_secret=secret,
            allowed_hosts=hosts,
            oidc_audience=audience,
        )

    def send(self, event: FreightEvent) -> httpx.Response:
        validate_egress_url(
            self.endpoint,
            self.allowed_hosts,
            allow_private_http=os.environ.get("AGROLOG_ALLOW_PRIVATE_HTTP", "0") == "1",
        )
        body = json.dumps(event.model_dump(mode="json"), sort_keys=True, separators=(",", ":")).encode()
        timestamp = str(int(time.time()))
        signature = hmac.new(
            self.shared_secret.encode("utf-8"),
            timestamp.encode("ascii") + b"." + body,
            hashlib.sha256,
        ).hexdigest()
        headers = {
            "content-type": "application/json",
            "x-agrolog-timestamp": timestamp,
            "x-agrolog-signature": f"sha256={signature}",
            "x-idempotency-key": f"{event.event_id}:{event.version}",
        }
        try:
            if self.oidc_audience:
                headers["authorization"] = (
                    f"Bearer {_fetch_identity_token(self.oidc_audience)}"
                )
            response = httpx.post(
                self.endpoint,
                content=body,
                headers=headers,
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
        except (httpx.HTTPError, GoogleAuthError, SecurityError) as exc:
            raise DeliveryError(f"AgroLog delivery failed: {type(exc).__name__}") from exc
        return response


class OutboxDispatcher:
    def __init__(self, store, client: AgroLogClient, tenant_id: str) -> None:
        if not tenant_id or len(tenant_id) > 128:
            raise ValueError("invalid tenant_id")
        self.store = store
        self.client = client
        self.tenant_id = tenant_id

    def flush(self, limit: int = 100) -> dict[str, int]:
        sent = 0
        failed = 0
        for outbox_id, event in self.store.pending_outbox(self.tenant_id, limit):
            if event.tenant_id != self.tenant_id:
                raise RuntimeError("outbox returned event outside dispatcher tenant")
            try:
                self.client.send(event)
            except DeliveryError as exc:
                self.store.mark_outbox_failed(
                    self.tenant_id,
                    outbox_id,
                    f"{type(exc).__name__}: {exc}",
                )
                failed += 1
                continue
            self.store.mark_outbox_sent(self.tenant_id, outbox_id)
            sent += 1
        return {"sent": sent, "failed": failed}
