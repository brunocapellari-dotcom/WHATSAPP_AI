from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import audit_whatsapp_export


def sample(tmp_path: Path) -> Path:
    path = tmp_path / "fretes.txt"
    path.write_text(
        "19/10/2026 05:19 - +55 66 99999-1111: "
        "ALFA TRANSPORTES\nSOJA R$/T\nDESTINO: RONDONÓPOLIS\n"
        "SORRISO - FAZENDA BOA VISTA R$ 180,00 /T\n",
        encoding="utf-8",
    )
    return path


def test_authorized_local_cli_returns_only_counts_not_freight_or_phone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    path = sample(tmp_path)
    monkeypatch.setenv("WPP_ALLOWED_CHAT_IDS", "12345@g.us")
    monkeypatch.setattr(
        "sys.argv",
        ["audit_whatsapp_export", "--file", str(path), "--group-id", "12345@g.us"],
    )
    assert audit_whatsapp_export.main() == 0
    output = capsys.readouterr()
    assert output.err == ""
    result = json.loads(output.out)
    assert result["transcript_messages"] == 1
    assert result["candidate_freight_rows"] == 1
    assert result["rows_with_required_fields"] == 1
    assert result["repeated_content_fingerprints"] == 0
    assert len(result["export_sha256"]) == 64
    for sensitive in ("180,00", "99999-1111", "ALFA", "12345@g.us", "BOA VISTA"):
        assert sensitive not in output.out


def test_export_audit_needs_a_real_approved_group_and_preexisting_allowlist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    path = sample(tmp_path)
    monkeypatch.delenv("WPP_ALLOWED_CHAT_IDS", raising=False)
    monkeypatch.setattr(
        "sys.argv",
        ["audit_whatsapp_export", "--file", str(path), "--group-id", "12345@g.us"],
    )
    assert audit_whatsapp_export.main() == 2
    assert "allowlist" in capsys.readouterr().err
    monkeypatch.setenv("WPP_ALLOWED_CHAT_IDS", "another@g.us")
    assert audit_whatsapp_export.main() == 2
    output = capsys.readouterr()
    assert "unauthorized input" in output.err
    assert "ALFA" not in output.err


def test_audit_file_rejects_symlinks_and_binary(tmp_path: Path) -> None:
    file = sample(tmp_path)
    link = tmp_path / "export-link.txt"
    link.symlink_to(file)
    with pytest.raises(ValueError, match="non-symlink"):
        audit_whatsapp_export.audit_file(
            link, group_id="12345@g.us", approved_groups={"12345@g.us"}
        )
    other = tmp_path / "export.zip"
    other.write_bytes(b"PK")
    with pytest.raises(ValueError, match="plaintext"):
        audit_whatsapp_export.audit_file(
            other, group_id="12345@g.us", approved_groups={"12345@g.us"}
        )
