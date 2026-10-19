from datetime import datetime

import pytest

from app.freight_reporting import MT_TIMEZONE
from app.report_schedule import due_slots


def at(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 10, day, hour, minute, tzinfo=MT_TIMEZONE)


def test_due_slots_returns_only_closed_publication_times() -> None:
    assert due_slots(at(15, 8, 30), at(15, 16)) == [at(15, 14)]
    assert due_slots(at(15, 14), at(15, 17)) == [at(15, 17)]
    assert due_slots(at(15, 17), at(16, 8, 29)) == []
    assert due_slots(at(15, 17), at(16, 8, 30)) == [at(16, 8, 30)]


def test_scheduler_catches_up_in_order_without_duplicates() -> None:
    result = due_slots(at(15, 8, 30), at(16, 14))
    assert result == [at(15, 14), at(15, 17), at(16, 8, 30), at(16, 14)]
    assert due_slots(at(16, 14), at(16, 14)) == []


def test_scheduler_rejects_unbounded_or_naive_inputs() -> None:
    with pytest.raises(ValueError):
        due_slots(None, datetime(2026, 10, 16, 14))
    with pytest.raises(ValueError):
        due_slots(None, at(16, 14), limit=0)
