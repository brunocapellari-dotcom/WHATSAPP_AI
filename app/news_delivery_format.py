"""Canonical, deterministic news presentation for authorized WhatsApp delivery.

This module intentionally does not collect articles, contact recipients or send
messages. Upstream must supply verified source data and a factual summary.
Downstream must enforce recipient consent, durable idempotency and acknowledgments.
"""
from __future__ import annotations

import hashlib
import ipaddress
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator


class NewsDispatchItem(BaseModel):
    """A single source-backed news item; no inferred quotes or fabricated facts."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    source_id: str = Field(min_length=1, max_length=128)
    source_event_id: str = Field(min_length=1, max_length=256)
    published_at: datetime
    instruments: list[str] = Field(min_length=1, max_length=5)
    headline: str = Field(min_length=1, max_length=280)
    provider: str = Field(min_length=1, max_length=120)
    source_url: HttpUrl
    short_summary: str | None = Field(default=None, max_length=600)

    @field_validator("published_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("published_at must include its timezone")
        return value

    @field_validator("instruments")
    @classmethod
    def normalize_instruments(cls, values: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for value in values:
            clean = _safe_text(value)
            if not clean or len(clean) > 40:
                raise ValueError("instrument labels must have 1-40 characters")
            if clean.casefold() not in seen:
                normalized.append(clean)
                seen.add(clean.casefold())
        if not normalized:
            raise ValueError("at least one named instrument is required")
        return normalized

    @field_validator("source_url")
    @classmethod
    def require_public_https(cls, value: HttpUrl) -> HttpUrl:
        host = value.host or ""
        if value.scheme != "https" or value.username or value.password:
            raise ValueError("article link must be an HTTPS URL without credentials")
        if not host or "." not in host or host == "localhost" or host.endswith(
            (".localhost", ".local", ".internal", ".test", ".invalid")
        ):
            raise ValueError("article link must have a public hostname")
        try:
            address = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            pass
        else:
            if not address.is_global:
                raise ValueError("article link must not use a private IP address")
        return value


def _safe_text(value: str) -> str:
    """Keep untrusted headlines as text, never as WhatsApp formatting markup."""
    result = " ".join(value.split())
    for marker in ("*", "_", "~", chr(96)):
        result = result.replace(marker, "")
    return result


def news_idempotency_key(item: NewsDispatchItem) -> str:
    """A source-scoped event key; distinct publishers must remain distinct."""
    material = item.source_id + "\x00" + item.source_event_id
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class NewsRow:
    """Fields displayed by the news panel, in TradingView-inspired order."""

    tempo: str
    instrumento: str
    titulo: str
    provedor: str
    resumo: str | None
    fonte_url: str
    publicado_em: str
    idempotency_key: str


def news_row(
    item: NewsDispatchItem, *, timezone: str = "America/Cuiaba"
) -> NewsRow:
    """Fixed publication time, not a mutable '1 hour ago' value."""
    local_time = item.published_at.astimezone(ZoneInfo(timezone))
    return NewsRow(
        tempo=local_time.strftime("%d/%m/%Y %H:%M"),
        instrumento=" / ".join(_safe_text(x) for x in item.instruments),
        titulo=_safe_text(item.headline),
        provedor=_safe_text(item.provider),
        resumo=_safe_text(item.short_summary) if item.short_summary else None,
        fonte_url=str(item.source_url),
        publicado_em=item.published_at.isoformat(),
        idempotency_key=news_idempotency_key(item),
    )


def render_news_whatsapp(
    item: NewsDispatchItem, *, timezone: str = "America/Cuiaba"
) -> str:
    """One readable, source-backed notification per article.

    WhatsApp text has no native TradingView-style table. All four columns remain
    explicit and ordered. Delivery policy is deliberately external to rendering.
    """
    row = news_row(item, timezone=timezone)
    pieces = [
        "*Últimas notícias*",
        f"*Tempo:* {row.tempo} ({timezone})",
        f"*Instrumento:* {row.instrumento}",
        f"*Título:* {row.titulo}",
        f"*Provedor:* {row.provedor}",
    ]
    if row.resumo:
        pieces.append(f"*Resumo:* {row.resumo}")
    pieces.append(f"*Fonte:* {row.fonte_url}")
    return "\n".join(pieces)
