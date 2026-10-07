from __future__ import annotations

from fastapi.testclient import TestClient

import app.main as main


class ReadyStore:
    def readiness_check(self) -> None:
        return None


class BrokenStore:
    def readiness_check(self) -> None:
        raise RuntimeError("database password must never be returned")


def test_liveness_does_not_claim_dependency_health() -> None:
    client = TestClient(main.app)
    response = client.get("/healthz", headers={"x-request-id": "health-123"})
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["x-request-id"] == "health-123"
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"


def test_readiness_checks_postgres(monkeypatch) -> None:
    monkeypatch.setattr(main, "_store", lambda: ReadyStore())
    client = TestClient(main.app)
    response = client.get("/readyz")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_readiness_fails_closed_without_leaking_exception(monkeypatch) -> None:
    monkeypatch.setattr(main, "_store", lambda: BrokenStore())
    client = TestClient(main.app)
    response = client.get("/readyz")
    assert response.status_code == 503
    assert response.json() == {"detail": "storage unavailable"}
    assert "password" not in response.text.lower()


def test_invalid_request_id_is_replaced() -> None:
    client = TestClient(main.app)
    response = client.get("/healthz", headers={"x-request-id": "bad request id\n"})
    assert response.status_code == 200
    assert response.headers["x-request-id"] != "bad request id\n"
    assert " " not in response.headers["x-request-id"]
