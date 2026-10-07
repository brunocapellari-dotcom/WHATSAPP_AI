from __future__ import annotations

from datetime import UTC, datetime

from app.integration import OutboxDispatcher
from app.models import FreightClassification, FreightEvent
from app.storage import InMemoryFreightStore


class FakeClient:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.sent: list[str] = []

    def send(self, event: FreightEvent):
        if self.fail:
            raise RuntimeError("down")
        self.sent.append(event.event_id)
        return object()


def event() -> FreightEvent:
    return FreightEvent(
        tenant_id="t",
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=["s1"],
        raw_reference="raw://1",
        timestamp=datetime(2026, 10, 7, tzinfo=UTC),
        confidence=0.9,
    )


def test_dispatcher_sends_pending_event() -> None:
    store = InMemoryFreightStore()
    e = event()
    store.enqueue_outbox(e)
    client = FakeClient()
    result = OutboxDispatcher(store, client).flush()
    assert result == {"sent": 1, "failed": 0}
    assert client.sent == [e.event_id]


def test_dispatcher_keeps_failed_event_pending() -> None:
    store = InMemoryFreightStore()
    store.enqueue_outbox(event())
    result = OutboxDispatcher(store, FakeClient(fail=True)).flush()
    assert result == {"sent": 0, "failed": 1}
    assert len(store.outbox) == 1
