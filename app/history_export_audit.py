"""Aggregate read-only freight-extraction audit from exported WhatsApp group TXT.

No output includes sender names, phone numbers, message bodies or freight values.
This is not a route to the operational DB or its report outbox.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .freight_multi_parser import parse_freight_lines
from .history_export import ExportReview


@dataclass(frozen=True)
class ExportFreightAudit:
    transcript_messages: int
    messages_with_freight_candidates: int
    candidate_freight_rows: int
    rows_with_required_fields: int
    rows_requiring_review: int
    repeated_content_fingerprints: int
    excluded_system_events: int
    excluded_invalid_headers: int
    excluded_oversized_messages: int
    first_message_at: datetime | None
    last_message_at: datetime | None
    export_sha256: str


def audit_export_freights(review: ExportReview) -> ExportFreightAudit:
    """Count freight-looking rows, not necessarily validated freight offers.

    This review does not resolve canonical city IDs, carrier aliases or unique
    cargo IDs. It must NEVER be used as an operational lot count.
    """
    candidate_messages = 0
    candidates = 0
    complete = 0
    fingerprint_seen: set[str] = set()
    repeated = 0
    for message in review.messages:
        if message.content_fingerprint in fingerprint_seen:
            repeated += 1
        else:
            fingerprint_seen.add(message.content_fingerprint)
        rows = parse_freight_lines(message.body, message.export_scoped_id)
        if rows:
            candidate_messages += 1
        candidates += len(rows)
        complete += sum(row.has_required_identity for row in rows)
    dates = [message.published_at for message in review.messages]
    return ExportFreightAudit(
        transcript_messages=review.count,
        messages_with_freight_candidates=candidate_messages,
        candidate_freight_rows=candidates,
        rows_with_required_fields=complete,
        rows_requiring_review=candidates - complete,
        repeated_content_fingerprints=repeated,
        excluded_system_events=review.system_events,
        excluded_invalid_headers=review.unparsed_headers,
        excluded_oversized_messages=review.truncated_messages,
        first_message_at=min(dates) if dates else None,
        last_message_at=max(dates) if dates else None,
        export_sha256=review.export_sha256,
    )
