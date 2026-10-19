"""Audit an authorized WhatsApp TXT export without storing or publishing it.

Usage:
  WPP_ALLOWED_CHAT_IDS='12345@g.us' python -m scripts.audit_whatsapp_export \
    --file /secure/local/group.txt --group-id '12345@g.us'

Output is intentionally limited to aggregate numbers and an archive checksum.
No recipient, carrier, rate or message text is printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from app.history_export import MAX_EXPORT_BYTES, parse_authorized_export
from app.history_export_audit import audit_export_freights


def audit_file(path: Path, *, group_id: str, approved_groups: set[str]) -> dict:
    """One-shot local verification. Does not open any network or DB connection."""
    if path.is_symlink() or not path.is_file():
        raise ValueError("export must be a regular non-symlink file")
    if path.suffix.lower() != ".txt":
        raise ValueError("only plaintext .txt exports are supported")
    if not 0 < path.stat().st_size <= MAX_EXPORT_BYTES:
        raise ValueError("export file exceeds accepted size")
    # Read-only local file, never print or copy contents to logs/cloud.
    content = path.read_text(encoding="utf-8-sig")
    review = parse_authorized_export(
        content, group_id=group_id, approved_group_ids=approved_groups
    )
    return asdict(audit_export_freights(review))


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only WhatsApp freight TXT audit")
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--group-id", required=True)
    args = parser.parse_args()
    allowlist = {
        item.strip()
        for item in os.environ.get("WPP_ALLOWED_CHAT_IDS", "").split(",")
        if item.strip()
    }
    if not allowlist:
        print("AUDIT_ERROR: group allowlist is not configured", file=sys.stderr)
        return 2
    try:
        result = audit_file(
            args.file, group_id=args.group_id, approved_groups=allowlist
        )
    except (OSError, UnicodeError, ValueError, TypeError):
        print("AUDIT_ERROR: invalid or unauthorized input", file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
