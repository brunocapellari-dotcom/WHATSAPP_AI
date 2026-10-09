from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import time
from dataclasses import dataclass
from urllib.parse import urlparse


class SecurityError(ValueError):
    pass


@dataclass(frozen=True)
class WebhookSecretResolver:
    secrets: dict[str, str]

    @classmethod
    def from_env(cls) -> WebhookSecretResolver:
        raw = os.environ.get("WHATSAPP_WEBHOOK_SECRETS", "{}")
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise TypeError("WHATSAPP_WEBHOOK_SECRETS must be a JSON object")
        return cls({str(k): str(v) for k, v in parsed.items()})

    def resolve(self, tenant_id: str, provider: str) -> str:
        key = f"{tenant_id}:{provider}"
        secret = self.secrets.get(key)
        if not secret:
            raise SecurityError("provider/tenant is not authorized")
        return secret


def verify_webhook_signature(
    body: bytes,
    *,
    timestamp: str | None,
    signature: str | None,
    secret: str,
    now_epoch: int | None = None,
    max_skew_seconds: int = 300,
) -> None:
    if not timestamp or not signature:
        raise SecurityError("missing webhook signature")
    try:
        ts = int(timestamp)
    except ValueError as exc:
        raise SecurityError("invalid webhook timestamp") from exc
    now = int(time.time()) if now_epoch is None else now_epoch
    if abs(now - ts) > max_skew_seconds:
        raise SecurityError("webhook timestamp outside replay window")
    expected = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    supplied = signature.removeprefix("sha256=")
    if not hmac.compare_digest(expected, supplied):
        raise SecurityError("invalid webhook signature")


def validate_egress_url(
    url: str,
    allowed_hosts: set[str],
    *,
    allow_private_http: bool = False,
) -> str:
    parsed = urlparse(url)
    if not parsed.hostname or parsed.hostname not in allowed_hosts:
        raise SecurityError("egress destination host is not allowlisted")
    if parsed.username or parsed.password:
        raise SecurityError("credentials in destination URL are forbidden")
    if parsed.scheme == "https":
        return url
    if parsed.scheme != "http" or not allow_private_http:
        raise SecurityError("egress destination must use HTTPS")
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        pass
    else:
        raise SecurityError("private HTTP egress must use an explicit local service hostname")
    if parsed.hostname not in {"ingress", "agrolog", "host.docker.internal"}:
        raise SecurityError("private HTTP egress host is not an approved local service")
    return url


def validate_oidc_audience(endpoint: str, audience: str) -> str:
    endpoint_parsed = urlparse(endpoint)
    audience_parsed = urlparse(audience)
    if audience_parsed.scheme != "https" or not audience_parsed.hostname:
        raise SecurityError("OIDC audience must be an HTTPS service origin")
    if audience_parsed.username or audience_parsed.password:
        raise SecurityError("credentials in OIDC audience are forbidden")
    if audience_parsed.query or audience_parsed.fragment:
        raise SecurityError("OIDC audience query/fragment is forbidden")
    if audience_parsed.path not in {"", "/"}:
        raise SecurityError("OIDC audience must not include an application path")
    if audience_parsed.hostname != endpoint_parsed.hostname:
        raise SecurityError("OIDC audience host must match egress endpoint host")
    return audience.rstrip("/")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
