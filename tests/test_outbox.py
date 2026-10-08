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


def event(source_id: str = "s1", tenant_id: str = "t") -> FreightEvent:
    return FreightEvent(
        tenant_id=tenant_id,
        classification=FreightClassification.FREIGHT_OFFER,
        source_event_ids=[source_id],
        raw_reference=f"raw://{source_id}",
        timestamp=datetime(2026, 10, 7, tzinfo=UTC),
        confidence=0.9,
    )


def dispatcher(store: InMemoryFreightStore, client: FakeClient, tenant_id: str = "t") -> OutboxDispatcher:
    return OutboxDispatcher(store, client, tenant_id=tenant_id)


def test_dispatcher_sends_pending_event() -> None:
    store = InMemoryFreightStore()
    e = event()
    store.enqueue_outbox(e)
    client = FakeClient()
    result = dispatcher(store, client).flush()
    assert result == {"sent": 1, "failed": 0}
    assert client.sent == [e.event_id]
    assert len(store.outbox) == 0


def test_dispatcher_never_crosses_tenant_boundary() -> None:
    store = InMemoryFreightStore()
    event_a = event("a", tenant_id="tenant-a")
    event_b = event("b", tenant_id="tenant-b")
    store.enqueue_outbox(event_a)
    store.enqueue_outbox(event_b)
    client = FakeClient()

    result = dispatcher(store, client, tenant_id="tenant-a").flush()

    assert result == {"sent": 1, "failed": 0}
    assert client.sent == [event_a.event_id]
    remaining = store.pending_outbox("tenant-b")
    assert len(remaining) == 1
    assert remaining[0][1].event_id == event_b.event_id


def test_dispatcher_keeps_transient_failure_pending() -> None:
    store = InMemoryFreightStore()
    store.enqueue_outbox(event())
    result = dispatcher(store, FakeClient(fail=True)).flush()
    assert result == {"sent": 0, "failed": 1}
    assert len(store.outbox) == 1
    assert len(store.dead_outbox) == 0


def test_dispatcher_moves_exhausted_failure_to_dead_letter() -> None:
    store = InMemoryFreightStore(max_outbox_attempts=3)
    store.enqueue_outbox(event())
    client = FakeClient(fail=True)

    for _ in range(3):
        result = dispatcher(store, client).flush()
        assert result == {"sent": 0, "failed": 1}

    assert len(store.outbox) == 0
    assert len(store.dead_outbox) == 1


def test_in_memory_outbox_ids_do_not_shift_after_send() -> None:
    store = InMemoryFreightStore()
    first = event("first")
    second = event("second")
    store.enqueue_outbox(first)
    store.enqueue_outbox(second)

    pending = store.pending_outbox("t")
    assert [row[0] for row in pending] == [1, 2]

    store.mark_outbox_sent("t", 1)
    pending = store.pending_outbox("t")
    assert [row[0] for row in pending] == [2]
    assert pending[0][1].event_id == second.event_id


def test_wrong_tenant_cannot_acknowledge_or_fail_event() -> None:
    store = InMemoryFreightStore(max_outbox_attempts=1)
    e = event("source", tenant_id="tenant-a")
    store.enqueue_outbox(e)

    store.mark_outbox_sent("tenant-b", 1)
    assert len(store.pending_outbox("tenant-a")) == 1

    store.mark_outbox_failed("tenant-b", 1, "should be ignored")
    assert len(store.pending_outbox("tenant-a")) == 1
    assert len(store.dead_outbox) == 0
