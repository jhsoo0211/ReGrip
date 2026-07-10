"""케이스 5: 도메인 검증 422 (maxForce < avgForce, 미래 startedAt)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from tests.conftest import register_and_auth


def test_max_force_less_than_avg_force_422(client):
    _, headers = register_and_auth(client)
    payload = {
        "clientSessionId": str(uuid.uuid4()),
        "exerciseType": "game_balloon",
        "startedAt": "2026-07-09T01:30:00Z",
        "durationSec": 600,
        "score": 5,
        "avgForce": 70.0,
        "maxForce": 50.0,  # avg > max → 모순
    }
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"


def test_future_started_at_422(client):
    _, headers = register_and_auth(client)
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    payload = {
        "clientSessionId": str(uuid.uuid4()),
        "exerciseType": "game_balloon",
        "startedAt": future,
        "durationSec": 600,
        "score": 5,
        "avgForce": 40.0,
        "maxForce": 60.0,
    }
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"


def test_negative_duration_422(client):
    _, headers = register_and_auth(client)
    payload = {
        "clientSessionId": str(uuid.uuid4()),
        "exerciseType": "game_balloon",
        "startedAt": "2026-07-09T01:30:00Z",
        "durationSec": 0,  # gt=0 위반
        "score": 5,
        "avgForce": 40.0,
        "maxForce": 60.0,
    }
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"
