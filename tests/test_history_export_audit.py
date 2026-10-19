from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
from zoneinfo import ZoneInfo

from app.history_export import parse_authorized_export
from app.history_export_audit import audit_export_freights

GROUP = "12345@g.us"


def audit(text: str):
    return audit_export_freights(
        parse_authorized_export(
            text, group_id=GROUP, approved_group_ids={GROUP}
        )
    )


def test_export_audit_counts_multiple_rows_without_marking_them_open() -> None:
    report = audit(
        "19/10/2026 05:19 - Transportes Alfa: "
        "RODOVIVA TRANSPORTES\nSOJA R$/T\nDESTINO: RONDONÓPOLIS\n"
        "SORRISO - FAZENDA BOA VISTA R$ 180,00 /T\n"
        "SINOP - FAZENDA BOA TARDE R$ 190,00 /T\n"
        "19/10/2026 05:20 - Carga Normal: Bom dia\n"
    )
    assert report.transcript_messages == 2
    assert report.messages_with_freight_candidates == 1
    assert report.candidate_freight_rows == 2
    assert report.rows_with_required_fields == 2
    assert report.rows_requiring_review == 0
    assert report.first_message_at == datetime(
        2026, 10, 19, 5, 19, tzinfo=ZoneInfo("America/Cuiaba")
    )
    assert report.last_message_at == datetime(
        2026, 10, 19, 5, 20, tzinfo=ZoneInfo("America/Cuiaba")
    )
    assert not hasattr(report, "open_lots")
    assert not hasattr(report, "average_rate")
    assert not hasattr(report, "sender")


def test_export_audit_detects_possible_republication_without_dropping_rows() -> None:
    body = (
        "RODOVIVA TRANSPORTES\nSOJA R$/T\nDESTINO: RONDONÓPOLIS\n"
        "SORRISO - FAZENDA BOA VISTA R$ 180,00 /T"
    )
    data = audit(
        f"19/10/2026 05:19 - Transportadora: {body}\n"
        f"19/10/2026 05:19 - Transportadora: {body}"
    )
    assert data.repeated_content_fingerprints == 1
    assert data.transcript_messages == 2
    assert data.candidate_freight_rows == 2  # Audit, NOT a definitive dedup.


def test_audit_summary_never_leaks_raw_message_or_rate() -> None:
    summary = audit(
        "19/10/2026 05:19 - +55 66 99999-1234: "
        "Transportadora: SOJA R$ 197,99"
    )
    dumped = str(asdict(summary))
    assert "99999-1234" not in dumped
    assert "197,99" not in dumped
    assert "Transportadora" not in dumped


def test_empty_or_only_system_export_has_no_freight_rows() -> None:
    data = audit("19/10/2026 05:19 - O grupo foi criado\n")
    assert data.transcript_messages == 0
    assert data.candidate_freight_rows == 0
    assert data.first_message_at is None
    assert data.excluded_system_events == 1
