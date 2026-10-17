from datetime import UTC, datetime, timedelta

import pytest

import app.report_operations as operations
from app.report_operations import probe_collector_health


class _Response:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


def test_collector_health_requires_private_services_and_recent_observation(
    monkeypatch,
) -> None:
    monkeypatch.setattr(operations.httpx, "get", lambda *args, **kwargs: _Response(200))
    now = datetime(2026, 10, 17, 14, 0, tzinfo=UTC)
    result = probe_collector_health(
        urls=(
            "http://bridge:8081/readyz",
            "http://wppconnect:21465/healthz",
        ),
        allowed_hosts={"bridge", "wppconnect"},
        last_observation_at=now - timedelta(minutes=5),
        now=now,
        max_idle_seconds=3600,
    )
    assert result.healthy
    assert result.reason is None


def test_collector_health_fails_closed_for_stale_observation(monkeypatch) -> None:
    monkeypatch.setattr(operations.httpx, "get", lambda *args, **kwargs: _Response(200))
    now = datetime(2026, 10, 17, 14, 0, tzinfo=UTC)
    result = probe_collector_health(
        urls=(
            "http://bridge:8081/readyz",
            "http://wppconnect:21465/healthz",
        ),
        allowed_hosts={"bridge", "wppconnect"},
        last_observation_at=now - timedelta(hours=2),
        now=now,
        max_idle_seconds=3600,
    )
    assert not result.healthy
    assert result.reason == "observation_stale_or_missing"


def test_collector_health_rejects_non_private_target(monkeypatch) -> None:
    monkeypatch.setattr(operations.httpx, "get", lambda *args, **kwargs: _Response(200))
    now = datetime(2026, 10, 17, 14, 0, tzinfo=UTC)
    with pytest.raises(ValueError, match="approved private"):
        probe_collector_health(
            urls=(
                "http://evil.example.com/readyz",
                "http://wppconnect:21465/healthz",
            ),
            allowed_hosts={"bridge", "wppconnect"},
            last_observation_at=now,
            now=now,
            max_idle_seconds=3600,
        )
