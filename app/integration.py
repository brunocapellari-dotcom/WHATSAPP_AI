from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass

import httpx

from .models import FreightEvent
from .security import validate_egress_url


@dataclass(frozen=True)
class AgroLogClient:
    endpoint: str
    shared_secret: str
    allowed_hosts: set[str]
    timeout_seconds: float = 10.0

    @classmethod
    def from_env(cls) -> "AgroLogClient":
        endpoint = os.environ["AGROLOG_FREIGHT_INGEST_URL"]
        secret = os.environ["AGROLOG_SHARED_SECRET"]
        hosts = {
            item.strip()
            for item in os.environ.get("AGROLOG_EGRESS_ALLOWED_HOSTS", "").split(",")
            if item.strip()
        }
        validate_egress_url(endpoint, hosts)
        return cls(
            endpoint=endpoint,
            shared_secret=secret,
            allowed_hosts=hosts,
        )

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
        response = httpx.post(
            self.endpoint,
            content=body,
            headers={
                "content-type": "application/json",
                "x-agrolog-timestamp": timestamp,
                "x-agrolog-signature": f"sha256={signature}",
                "x-idempotency-key": f"{event.event_id}:{event.version}",
            },
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
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
            except Exception as exc:
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
