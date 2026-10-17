from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid

from fastapi import FastAPI, Header, HTTPException, Request, status

from .models import IngestionResult, RawInboundEvent
from .pipeline import FreightPipeline
from .security import SecurityError, WebhookSecretResolver, verify_webhook_signature
from .storage import PostgresFreightStore

MAX_BODY_BYTES = int(os.environ.get("WHATSAPP_MAX_WEBHOOK_BYTES", "1000000"))
REQUEST_ID_MAX = 128
PROVIDER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TENANT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
ALLOWED_MIME = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/pdf",
    "text/plain",
}

logger = logging.getLogger("whatsapp_ai.ingress")

app = FastAPI(
    title="WhatsApp AI Freight Ingestion",
    version="0.1.0",
    docs_url=None if os.environ.get("ENABLE_DOCS", "0") != "1" else "/docs",
    redoc_url=None,
)


def _store() -> PostgresFreightStore:
    return PostgresFreightStore.from_env()


def _request_id(value: str | None) -> str:
    if value and 1 <= len(value) <= REQUEST_ID_MAX and all(
        ch.isalnum() or ch in "._:-" for ch in value
    ):
        return value
    return str(uuid.uuid4())


def _validate_security_identifier(value: str, *, kind: str) -> str:
    pattern = PROVIDER_ID_RE if kind == "provider" else TENANT_ID_RE
    if not pattern.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"invalid {kind} identifier")
    return value


def _validate_attachments(event: RawInboundEvent) -> None:
    for attachment in event.attachments:
        if attachment.mime_type and attachment.mime_type.lower() not in ALLOWED_MIME:
            raise HTTPException(status_code=415, detail="attachment MIME is not allowed")
        if attachment.storage_reference is not None:
            raise HTTPException(
                status_code=422,
                detail="attachment byte references are disabled until quarantine scanning is enabled",
            )
        if attachment.content_hash and not SHA256_RE.fullmatch(attachment.content_hash):
            raise HTTPException(status_code=422, detail="attachment content_hash must be SHA-256")


@app.middleware("http")
async def secure_request_logging(request: Request, call_next):
    request_id = _request_id(request.headers.get("x-request-id"))
    started = time.monotonic()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        response.headers["x-request-id"] = request_id
        response.headers["cache-control"] = "no-store, max-age=0"
        response.headers["pragma"] = "no-cache"
        response.headers["x-content-type-options"] = "nosniff"
        response.headers["x-frame-options"] = "DENY"
        response.headers["referrer-policy"] = "no-referrer"
        return response
    finally:
        logger.info(
            json.dumps(
                {
                    "event": "ingress_request",
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": status_code,
                    "duration_ms": round((time.monotonic() - started) * 1000, 2),
                },
                sort_keys=True,
            )
        )


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict[str, str]:
    try:
        _store().readiness_check()
    except Exception as exc:
        logger.warning(
            json.dumps(
                {
                    "event": "readiness_failed",
                    "dependency": "postgres",
                    "error_type": type(exc).__name__,
                },
                sort_keys=True,
            )
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="storage unavailable",
        ) from exc
    return {"status": "ready"}


@app.post(
    "/v1/providers/{provider}/events",
    response_model=IngestionResult,
    status_code=status.HTTP_202_ACCEPTED,
)
async def provider_event(
    provider: str,
    request: Request,
    x_tenant_id: str = Header(..., min_length=1, max_length=128),
    x_webhook_timestamp: str | None = Header(default=None),
    x_webhook_signature: str | None = Header(default=None),
) -> IngestionResult:
    provider = _validate_security_identifier(provider, kind="provider")
    x_tenant_id = _validate_security_identifier(x_tenant_id, kind="tenant")
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
        logger.warning(
            json.dumps(
                {
                    "event": "webhook_authentication_failed",
                    "provider": provider,
                    "tenant_id_hash": hashlib.sha256(x_tenant_id.encode("utf-8")).hexdigest()[:12],
                    "error_type": type(exc).__name__,
                },
                sort_keys=True,
            )
        )
        raise HTTPException(status_code=401, detail="invalid webhook authentication") from exc

    try:
        raw = RawInboundEvent.model_validate_json(body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="malformed provider payload") from exc

    _validate_attachments(raw)
    pipeline = FreightPipeline(_store())
    return pipeline.ingest(x_tenant_id, provider, raw)
