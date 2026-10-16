"""Deterministic Cuiabá report schedule with no external scheduler dependency."""
from __future__ import annotations

from datetime import datetime, timedelta

from .freight_reporting import MT_TIMEZONE, REPORT_TIMES, validate_slot


def due_slots(last_closed: datetime | None, now: datetime, *, limit: int = 90) -> list[datetime]:
    """Return past scheduled slots not yet closed, oldest first.

    A caller must persist each successful closure before advancing last_closed.
    Never run this function with an unbounded catch-up window.
    """
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    if last_closed is not None:
        validate_slot(last_closed)
    if limit < 1 or limit > 90:
        raise ValueError("limit must be between 1 and 90")
    local_now = now.astimezone(MT_TIMEZONE)
    first_day = ((last_closed.astimezone(MT_TIMEZONE).date()
                  if last_closed else local_now.date() - timedelta(days=1)))
    result: list[datetime] = []
    day = first_day
    while day <= local_now.date():
        for hour, minute in sorted(REPORT_TIMES):
            cutoff = datetime(day.year, day.month, day.day, hour, minute,
                              tzinfo=MT_TIMEZONE)
            if cutoff <= local_now and (last_closed is None or cutoff > last_closed):
                result.append(cutoff)
                if len(result) >= limit:
                    return result
        day += timedelta(days=1)
    return result
