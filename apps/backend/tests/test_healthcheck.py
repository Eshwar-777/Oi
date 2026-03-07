from fastapi.testclient import TestClient

from oi_agent.main import app


def test_healthcheck() -> None:
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_readiness() -> None:
    client = TestClient(app)
    response = client.get("/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ok", "degraded"}
    assert "checks" in body


def test_internal_scheduled_task_check() -> None:
    client = TestClient(app)
    response = client.post("/internal/check-scheduled-tasks")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
