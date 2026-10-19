"""Read-only parser for legitimately exported WhatsApp group TXT transcripts.

A WhatsApp text export has no trustworthy provider message IDs, chat ID, or
completeness guarantee. Nothing in this module writes DB rows or changes live
cargo status. Callers must obtain consent and retain the raw file privately.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

MAX_EXPORT_BYTES = 20_000_000
MAX_EXPORT_MESSAGES = 50_000
MAX_MESSAGE_CHARS = 50_000
# Only explicit Brazilian dd/mm/yy(yy) forms are accepted; no locale guessing.
# Supported Android forms: 19/10/2026 08:31 - Nome: Mensagem
# Supported iOS forms:     [19/10/2026, 08:31:00] Nome: Mensagem
_EXPORT_HEADER = re.compile(
    r"^(?:\u200e|\u200f|\ufeff)*"
    r"(?:\[(?P<bd>\d{1,2}/\d{1,2}/\d{4}),?\s*"
    r"(?P<bt>\d{1,2}:\d{2}(?::\d{2})?)\]\s*"
    r"|(?P<d>\d{1,2}/\d{1,2}/\d{4}),?\s*"
    r"(?P<t>\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*)"
    r"(?P<content>.*)$"
)

_DEFAULT_TZ = ZoneInfo("America/Cuiaba")


@dataclass(frozen=True)
class ExportedMessage:
    """Ephemeral parsed record. Never log its sender or original text."""

    line_number: int
    published_at: datetime
    sender: str
    body: str
    # Not a true WhatsApp message ID: repeated exports can shift line numbers.
    export_scoped_id: str
    # Useful for possible duplicate review, NOT safe as a definitive message ID.
    content_fingerprint: str


@dataclass(frozen=True)
class ExportReview:
    messages: tuple[ExportedMessage, ...]
    unparsed_headers: int
    system_events: int
    truncated_messages: int
    export_sha256: str

    @property
    def count(self) -> int:
        return len(self.messages)


def _timestamp(date_text: str, time_text: str, timezone: ZoneInfo) -> datetime:
    value = f"{date_text} {time_text}"
    layout = "%d/%m/%Y %H:%M:%S" if time_text.count(":") == 2 else "%d/%m/%Y %H:%M"
    return datetime.strptime(value, layout).replace(tzinfo=timezone)


def _content_id(group_id: str, when: datetime, sender: str, body: str) -> str:
    data = f"{group_id}\x00{when.isoformat()}\x00{sender}\x00{body}"
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def parse_authorized_export(
    contents: str,
    *,
    group_id: str,
    approved_group_ids: set[str],
    timezone: ZoneInfo = _DEFAULT_TZ,
) -> ExportReview:
    """Parse a plain-text group export for auditing, without persistent writes.

    Group ID is an externally verified *source label*, not information inferred
    from the file. Never use this parser to claim that old cargo is still open.
    Do not promote exported content to canonical truth without auditing.
    """
    if not isinstance(contents, str):
        raise TypeError("export must be plain-text Unicode")
    if group_id not in approved_group_ids or not group_id.endswith("@g.us"):
        raise ValueError("export is not from an authorized WhatsApp group")
    if not isinstance(timezone, ZoneInfo):
        raise TypeError("an explicit IANA timezone is required")
    size = len(contents.encode("utf-8"))
    if size == 0 or size > MAX_EXPORT_BYTES:
        raise ValueError("export size is outside accepted range")
    export_sha = hashlib.sha256(contents.encode("utf-8")).hexdigest()
    parsed: list[ExportedMessage] = []
    unparsed = 0
    system_events = 0
    truncated = 0
    sender: str | None = None
    stamp: datetime | None = None
    first_line: int = 0
    body_lines: list[str] = []
    current_size = 0

    def flush() -> None:
        nonlocal truncated
        if stamp is None or sender is None:
            return
        if current_size > MAX_MESSAGE_CHARS:
            truncated += 1
            return
        body = "\n".join(body_lines).strip()
        if not body:
            return
        if len(parsed) >= MAX_EXPORT_MESSAGES:
            raise ValueError("export exceeds supported message count")
        # Local index gives stable IDs only for exactly the same file.
        scoped = hashlib.sha256(
            f"{export_sha}\x00{first_line}".encode()
        ).hexdigest()
        parsed.append(
            ExportedMessage(
                line_number=first_line,
                published_at=stamp,
                sender=sender,
                body=body,
                export_scoped_id=scoped,
                content_fingerprint=_content_id(group_id, stamp, sender, body),
            )
        )

    for line_number, raw_line in enumerate(contents.splitlines(), 1):
        line = raw_line.lstrip("\u200e\u200f\ufeff")
        candidate = _EXPORT_HEADER.fullmatch(line)
        if candidate is None:
            if stamp is not None:
                current_size += len(raw_line) + 1
                if current_size <= MAX_MESSAGE_CHARS:
                    body_lines.append(raw_line)
            else:
                unparsed += 1
            continue

        date = candidate.group("bd") or candidate.group("d")
        clock = candidate.group("bt") or candidate.group("t")
        try:
            parsed_at = _timestamp(date, clock, timezone)
        except ValueError:
            # A message-shaped invalid date can be part of previous message.
            # Fail closed rather than misattribute or invent a date.
            flush()
            stamp = None
            sender = None
            body_lines = []
            current_size = 0
            unparsed += 1
            continue

        flush()
        stamp = None
        sender = None
        body_lines = []
        current_size = 0

        content = candidate.group("content")
        # System notifications have no sender/body delimiter. They are excluded.
        if ": " not in content:
            system_events += 1
            continue
        actor, initial = content.split(": ", 1)
        actor = actor.strip()
        if not actor or len(actor) > 256:
            system_events += 1
            continue
        stamp = parsed_at
        first_line = line_number
        sender = actor
        current_size = len(initial)
        if current_size <= MAX_MESSAGE_CHARS:
            body_lines.append(initial)
    flush()
    return ExportReview(tuple(parsed), unparsed, system_events, truncated, export_sha)
