"""Read-only preview of WPPConnect chat history for authorized freight groups.

This module NEVER calls the WhatsApp provider, writes to the database, or
publishes a freight report. An explicitly enabled importer with its own
historical-data isolation is required before old messages can be stored.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from .provider_bridge import normalize_wppconnect_event

MAX_PAGE_MESSAGES = 500
MAX_REVIEW_DAYS = 366


@dataclass(frozen=True)
class HistoricalCandidate:
    """Private message preview: never expose message body, sender or group ID."""

    message_id_sha256: str
    content_sha256: str
    published_at: datetime
    has_media: bool


@dataclass(frozen=True)
class HistoricalPreview:
    # Counts are for the returned page, NOT proof of historical completeness.
    candidates: tuple[HistoricalCandidate, ...]
    ignored_other_chats: int
    ignored_self_messages: int
    ignored_outside_window: int
    ignored_invalid: int
    ignored_duplicates: int

    @property
    def candidate_count(self) -> int:
        return len(self.candidates)


def _aware(value: datetime, label: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{label} must have explicit timezone")
    return value.astimezone(UTC)


def preview_history_page(
    messages: list[dict[str, Any]],
    *,
    session: str,
    group_id: str,
    approved_chat_ids: set[str],
    since: datetime,
    until: datetime,
) -> HistoricalPreview:
    """Inspect one authorized history page, without ingestion or disclosure.

    Input messages must have a stable string ID, Unix timestamp and chatId.
    WPPConnect's historical API schemas may vary by server version: a future
    provider adapter must validate the real response before using this routine.
    No inferred chat, date or sender values are ever accepted.
    """
    if group_id not in approved_chat_ids or not group_id.endswith("@g.us"):
        raise ValueError("only explicitly authorized WhatsApp groups are allowed")
    if not session or len(session) > 128:
        raise ValueError("session is required")
    start, end = _aware(since, "since"), _aware(until, "until")
    if end < start or end - start > timedelta(days=MAX_REVIEW_DAYS):
        raise ValueError("history range must span 0-366 days")
    if len(messages) > MAX_PAGE_MESSAGES:
        raise ValueError("history page is larger than the supported limit")

    seen: set[str] = set()
    candidates: list[HistoricalCandidate] = []
    other_chats = self_messages = outside = invalid = duplicates = 0

    for raw in messages:
        if not isinstance(raw, dict):
            invalid += 1
            continue
        if raw.get("chatId") != group_id:
            other_chats += 1
            continue
        if raw.get("fromMe") is True:
            self_messages += 1
            continue
        # An explicit wrapper prevents a history item from asserting another
        # session or injecting arbitrary provider event types.
        safe = dict(raw)
        safe["session"] = session
        safe["event"] = "onmessage"
        try:
            event = normalize_wppconnect_event(
                safe, allowed_sessions={session}, allowed_chat_ids={group_id}
            )
        except (ValueError, TypeError, OverflowError):
            invalid += 1
            continue
        if event is None:
            invalid += 1
            continue
        stamp = event.message_timestamp.astimezone(UTC)
        if not start <= stamp <= end:
            outside += 1
            continue
        if not event.raw_text.strip():
            invalid += 1
            continue
        if event.source_event_id in seen:
            duplicates += 1
            continue
        seen.add(event.source_event_id)
        candidates.append(
            HistoricalCandidate(
                message_id_sha256=hashlib.sha256(
                    event.source_event_id.encode("utf-8")
                ).hexdigest(),
                content_sha256=hashlib.sha256(
                    event.raw_text.encode("utf-8")
                ).hexdigest(),
                published_at=stamp,
                has_media=bool(event.attachments),
            )
        )
    candidates.sort(key=lambda item: (item.published_at, item.message_id_sha256))
    return HistoricalPreview(
        tuple(candidates), other_chats, self_messages, outside, invalid, duplicates
    )
