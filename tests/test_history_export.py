from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.history_export import MAX_MESSAGE_CHARS, parse_authorized_export

CHAT = "12345@g.us"
MT = ZoneInfo("America/Cuiaba")


def parse(text: str):
    return parse_authorized_export(text, group_id=CHAT, approved_group_ids={CHAT})


def test_android_export_preserves_multiline_freight_original_date_and_sender() -> None:
    record = parse(
        "19/10/2026, 05:19 - Transportes Alfa: *FRETES LIBERADOS*\n"
        "SOJA R$/T\nDESTINO: RONDONÓPOLIS\n"
        "SORRISO - FAZENDA BOA VISTA R$ 180,00 /T\n"
        "19/10/2026, 05:20 - Transportes Beta: Tudo certo\n"
    )
    assert record.count == 2
    assert record.messages[0].sender == "Transportes Alfa"
    assert record.messages[0].published_at == datetime(2026, 10, 19, 5, 19, tzinfo=MT)
    assert "SORRISO - FAZENDA BOA VISTA" in record.messages[0].body
    assert record.messages[1].body == "Tudo certo"
    assert record.messages[0].line_number == 1
    assert record.messages[1].line_number == 5


def test_ios_export_bracketed_timestamp_supports_seconds() -> None:
    result = parse(
        "[19/10/2026, 08:31:05] +55 66 99999-1111: SOJA FRETE R$ 172,00\n"
        "[19/10/2026, 08:32:01] +55 66 99999-2222: MILHO R$ 180,00"
    )
    assert result.count == 2
    assert result.messages[0].published_at == datetime(
        2026, 10, 19, 8, 31, 5, tzinfo=MT
    )


def test_export_uses_explicit_mato_grosso_timezone_not_utc_assumption() -> None:
    result = parse("19/10/2026 10:01 - ABC: milho R$ 140,00")
    assert result.messages[0].published_at.utcoffset().total_seconds() == -14400


def test_group_permission_is_mandatory_even_for_txt_files() -> None:
    with pytest.raises(ValueError, match="authorized"):
        parse_authorized_export(
            "19/10/2026 10:00 - A: Frete R$ 140",
            group_id="other@g.us",
            approved_group_ids={CHAT},
        )
    with pytest.raises(ValueError, match="authorized"):
        parse_authorized_export(
            "19/10/2026 10:00 - A: Frete R$ 140",
            group_id="55999999@c.us",
            approved_group_ids={"55999999@c.us"},
        )


def test_export_repeated_exactly_does_not_change_deterministic_fingerprints() -> None:
    text = "19/10/2026 10:00 - Carrier: Frete soja R$ 200"
    first = parse(text)
    second = parse(text)
    assert first.export_sha256 == second.export_sha256
    assert first.messages[0].export_scoped_id == second.messages[0].export_scoped_id
    assert first.messages[0].content_fingerprint == second.messages[0].content_fingerprint


def test_export_content_fingerprint_is_not_source_message_id() -> None:
    a = parse("19/10/2026 10:00 - Carrier: Frete soja R$ 200")
    b = parse("19/10/2026 10:00 - Carrier: Frete soja R$ 200\n")
    assert a.messages[0].content_fingerprint == b.messages[0].content_fingerprint
    assert a.messages[0].export_scoped_id != b.messages[0].export_scoped_id


def test_system_notices_are_ignored_not_misrepresented_as_freights() -> None:
    data = parse(
        "19/10/2026 10:00 - Mensagens e ligações são protegidas com criptografia\n"
        "19/10/2026 10:01 - Administrador alterou configurações do grupo\n"
        "19/10/2026 10:02 - Carrier: Frete R$ 110,00\n"
    )
    assert data.system_events == 2
    assert data.count == 1


def test_invalid_dates_are_rejected_without_backdating_next_message() -> None:
    result = parse(
        "19/10/2026 08:00 - Transportadora: Frete R$ 150\n"
        "31/02/2026 08:01 - Transportadora: FALSO\n"
        "19/10/2026 08:02 - Outra: Frete R$ 160"
    )
    assert result.unparsed_headers == 1
    assert result.count == 2
    assert "FALSO" not in result.messages[0].body
    assert result.messages[1].body == "Frete R$ 160"


def test_invalid_export_format_never_invents_date_or_sender() -> None:
    result = parse("Documento inválido\nSem datas nem autores")
    assert result.count == 0
    assert result.unparsed_headers == 2


def test_truncation_is_rejected_not_silently_accepted() -> None:
    result = parse("19/10/2026 10:01 - ABC: " + ("x" * (MAX_MESSAGE_CHARS + 1)))
    assert result.count == 0
    assert result.truncated_messages == 1


def test_repeated_whatsapp_text_is_not_assumed_to_be_same_physical_load() -> None:
    result = parse(
        "19/10/2026 10:00 - Carrier: Frete soja R$ 200\n"
        "19/10/2026 10:00 - Carrier: Frete soja R$ 200"
    )
    assert result.count == 2
    assert result.messages[0].export_scoped_id != result.messages[1].export_scoped_id
    assert result.messages[0].content_fingerprint == result.messages[1].content_fingerprint


def test_bad_timezone_and_empty_export_are_rejected() -> None:
    with pytest.raises(ValueError, match="IANA"):
        parse_authorized_export(
            "19/10/2026 10:00 - C: R$ 100",
            group_id=CHAT,
            approved_group_ids={CHAT},
            timezone=None,
        )
    with pytest.raises(ValueError, match="size"):
        parse("")
