from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass

import httpx
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token

from .models import FreightEvent
from .security import validate_egress_url


@dataclass(frozen=True)
class AgroLogClient:
    endpoint: str
    shared_secret: str
    allowed_hosts: set[str]
    timeout_seconds: float = 10.0
    id_token_audience: str | None = None

    @classmethod
    def from_env(cls) -> "AgroLogClient":
        endpoint = os.environ["AGROLOG_FREIGHT_INGEST_URL"]
        secret = os.environ["AGROLOG_SHARED_SECRET"]
        hosts = {
            item.strip()
            for item in os.environ.get("AGROLOG_EGRESS_ALLOWED_HOSTS", "").split(",")
            if item.strip()
        }
        audience = os.environ.get("AGROLOG_ID_TOKEN_AUDIENCE")
        validate_egress_url(endpoint, hosts)
        if audience:
            validate_egress_url(audience, hosts)
        return cls(
            endpoint=endpoint,
            shared_secret=secret,
            allowed_hosts=hosts,
            id_token_audience=audience,
        )

    def _authorization_header(self) -> str | None:
        if not self.id_token_audience:
            return None
        token = id_token.fetch_id_token(
            GoogleAuthRequest(),
            self.id_token_audience,
        )
        if not token:
            raise RuntimeError("failed to obtain AgroLog Cloud Run identity token")
        return f"Bearer {token}"

    def send(self, event: FreightEvent) -> httpx.Response:
        validate_egress_url(self.endpoint, self.allowed_hosts)
        body = json.dumps(
            event.model_dump(mode="json"),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
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
        authorization = self._authorization_header()
        if authorization:
            headers["authorization"] = authorization

        response = httpx.post(
            self.endpoint,
            content=body,
            headers=headers,
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        return response


class OutboxDispatcher:
    def __init__(self, store, client: AgroLogClient) -> None:
        self.store = store
        self.client = client

    def flush(self, limit: int = 100) -> dict[str, int]:
        sent = 0
        failed = 0
        for outbox_id, event in self.store.pending_outbox(limit):
            try:
                self.client.send(event)
            except Exception as exc:
                self.store.mark_outbox_failed(outbox_id, f"{type(exc).__name__}: {exc}")
                failed += 1
                continue
            self.store.mark_outbox_sent(outbox_id)
            sent += 1
        return {"sent": sent, "failed": failed}
