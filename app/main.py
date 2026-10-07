from __future__ import annotations

import os

from fastapi import FastAPI, Header, HTTPException, Request, status

from .models import IngestionResult, RawInboundEvent
from .pipeline import FreightPipeline
from .security import SecurityError, WebhookSecretResolver, verify_webhook_signature
from .storage import PostgresFreightStore

MAX_BODY_BYTES = int(os.environ.get("WHATSAPP_MAX_WEBHOOK_BYTES", "1000000"))
ALLOWED_MIME = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
    "text/plain",
}

app = FastAPI(
    title="WhatsApp AI Freight Ingestion",
    version="0.1.0",
    docs_url=None if os.environ.get("ENABLE_DOCS", "0") != "1" else "/docs",
)


def _store() -> PostgresFreightStore:
    store = PostgresFreightStore.from_env()
    store.ensure_schema()
    return store


def _validate_attachments(event: RawInboundEvent) -> None:
    for attachment in event.attachments:
        if attachment.mime_type and attachment.mime_type.lower() not in ALLOWED_MIME:
            raise HTTPException(status_code=415, detail="attachment MIME is not allowed")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/providers/{provider}/events", response_model=IngestionResult, status_code=status.HTTP_202_ACCEPTED)
async def provider_event(
    provider: str,
    request: Request,
    x_tenant_id: str = Header(..., min_length=1, max_length=128),
    x_webhook_timestamp: str | None = Header(default=None),
    x_webhook_signature: str | None = Header(default=None),
) -> IngestionResult:
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="webhook body too large")

    resolver = WebhookSecretResolver.from_env()
    try:
        secret = resolver.resolve(x_tenant_id, provider)
        verify_webhook_signature(
            body,
            timestamp=x_webhook_timestamp,
            signature=x_webhook_signature,
            secret=secret,
        )
    except SecurityError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    try:
        raw = RawInboundEvent.model_validate_json(body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="malformed provider payload") from exc

    _validate_attachments(raw)
    pipeline = FreightPipeline(_store())
    return pipeline.ingest(x_tenant_id, provider, raw)
