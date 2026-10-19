"""Historical snapshots are review-only and never reopen older freight lots."""
from __future__ import annotations

import hashlib
from dataclasses import asdict
from datetime import UTC, datetime, timedelta

import pytest

from app.history_preview import MAX_PAGE_MESSAGES, preview_history_page

GROUP = "12345@g.us"
OTHER_GROUP = "67890@g.us"
SESSION = "freight-prod"
START = datetime(2026, 10, 16, tzinfo=UTC)
END = datetime(2026, 10, 19, tzinfo=UTC)
OLD = datetime(2026, 10, 17, 12, tzinfo=UTC)


def msg(**overrides: object) -> dict[str, object]:
    item: dict[str, object] = {
        "id": "3EB0ABC123",
        "chatId": GROUP,
        "session": "malicious-attempt-to-switch-session",
        "event": "other-event",
        "timestamp": int(OLD.timestamp()),
        "fromMe": False,
        "body": "Frete soja Sorriso MT para Rondonópolis R$ 180",
        "isGroupMsg": True,
        "type": "chat",
    }
    item.update(overrides)
    return item


def preview(messages: list[dict[str, object]]):
    return preview_history_page(
        messages,
        session=SESSION,
        group_id=GROUP,
        approved_chat_ids={GROUP},
        since=START,
        until=END,
    )


def test_old_message_preserves_original_date_and_only_exposes_hashes() -> None:
    sample = msg(body="Frete privado 180 telefone 123456")
    result = preview([sample])
    assert result.candidate_count == 1
    candidate = result.candidates[0]
    assert candidate.published_at == OLD
    assert candidate.content_sha256 == hashlib.sha256(
        str(sample["body"]).encode()
    ).hexdigest()
    serialized = str(asdict(result))
    assert "123456" not in serialized
    assert str(sample["body"]) not in serialized
    assert GROUP not in serialized
    assert "3EB0ABC123" not in serialized


def test_replay_same_message_id_remains_identical_across_pages() -> None:
    first = preview([msg()])
    second = preview([msg(), msg()])
    assert first.candidates == second.candidates
    assert second.ignored_duplicates == 1
    assert second.candidate_count == 1


def test_mixed_chat_history_rejects_other_groups_and_private_chats() -> None:
    result = preview(
        [
            msg(chatId=OTHER_GROUP, id="group-b"),
            msg(chatId="5511999999999@c.us", id="personal"),
            msg(fromMe=True, id="self"),
            msg(id="approved"),
        ]
    )
    assert result.candidate_count == 1
    assert result.ignored_other_chats == 2
    assert result.ignored_self_messages == 1


def test_no_unauthorized_or_private_group_is_ever_accepted() -> None:
    for denied in (OTHER_GROUP, "5511999999999@c.us"):
        with pytest.raises(ValueError, match="authorized"):
            preview_history_page(
                [msg(chatId=denied)],
                session=SESSION,
                group_id=denied,
                approved_chat_ids={GROUP},
                since=START,
                until=END,
            )
    with pytest.raises(ValueError, match="authorized"):
        preview_history_page(
            [msg(chatId="5511999999999@c.us")],
            session=SESSION,
            group_id="5511999999999@c.us",
            approved_chat_ids={"5511999999999@c.us"},
            since=START,
            until=END,
        )


def test_outside_period_and_missing_timestamp_not_fabricated() -> None:
    result = preview(
        [
            msg(timestamp=int(datetime(2026, 10, 10, tzinfo=UTC).timestamp())),
            msg(id="notimestamp", timestamp=None),
            msg(id="inside-window"),
        ]
    )
    assert result.candidate_count == 1
    assert result.ignored_outside_window == 1
    assert result.ignored_invalid == 1


def test_invalid_identity_or_ambiguous_history_record_is_skipped() -> None:
    result = preview(
        [
            msg(id=None),
            msg(id={"_serialized": "whatever"}),
            msg(id="no-text", body=""),
            msg(id="plain-caption", body="", isMedia=True, caption="SOJA FRETE R$ 200"),
        ]
    )
    assert result.candidate_count == 1
    assert result.candidates[0].has_media
    assert result.ignored_invalid == 3


def test_timestamp_is_ordered_chronologically_and_not_ingestion_time() -> None:
    newer = OLD + timedelta(hours=10)
    result = preview(
        [
            msg(id="new", timestamp=int(newer.timestamp())),
            msg(id="old", timestamp=int(OLD.timestamp())),
        ]
    )
    assert [x.published_at for x in result.candidates] == [OLD, newer]


def test_preview_rejects_oversized_pages_and_ambiguous_timezones() -> None:
    with pytest.raises(ValueError, match="supported limit"):
        preview([msg()] * (MAX_PAGE_MESSAGES + 1))
    with pytest.raises(ValueError, match="timezone"):
        preview_history_page(
            [msg()],
            session=SESSION,
            group_id=GROUP,
            approved_chat_ids={GROUP},
            since=datetime(2026, 10, 16),
            until=END,
        )
    with pytest.raises(ValueError, match="0-366"):
        preview_history_page(
            [msg()],
            session=SESSION,
            group_id=GROUP,
            approved_chat_ids={GROUP},
            since=datetime(2025, 1, 1, tzinfo=UTC),
            until=END,
        )


def test_preview_has_no_delivery_or_database_side_effects() -> None:
    result = preview([msg()])
    assert result.candidate_count == 1
    # Not a RawInboundEvent / report: only non-reversible fingerprints.
    assert not hasattr(result.candidates[0], "raw_text")
    assert not hasattr(result.candidates[0], "recipient")
