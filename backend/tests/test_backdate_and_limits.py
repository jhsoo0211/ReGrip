"""회귀: 백데이트 하한(A1), 수신일 기준 일일 상한(A2), sets 중복/deviceId/score 상한(C1/C2/C3)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from tests.conftest import register_and_auth


def _payload(started_iso, *, score=5, csid=None):
    return {
        "clientSessionId": csid or str(uuid.uuid4()),
        "exerciseType": "game_balloon",
        "startedAt": started_iso,
        "durationSec": 300,
        "score": score,
        "avgForce": 40.0,
        "maxForce": 60.0,
    }


# ── A1: 백데이트 하한 ─────────────────────────────────────────────
def test_backdate_beyond_72h_rejected(client):
    _, headers = register_and_auth(client)
    started = (datetime.now(timezone.utc) - timedelta(hours=73)).isoformat()
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=_payload(started))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"
    assert r.json()["error"]["details"]["field"] == "startedAt"


def test_backdate_within_72h_accepted(client):
    _, headers = register_and_auth(client)
    started = (datetime.now(timezone.utc) - timedelta(hours=71)).isoformat()
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=_payload(started))
    assert r.status_code == 201, r.text


# ── A2: 일일 상한은 '주장된 startedAt' 이 아니라 서버 수신일 기준 ──
def test_daily_cap_counts_by_receipt_not_claimed_date(client):
    _, headers = register_and_auth(client)
    now = datetime.now(timezone.utc)
    # 백데이트를 여러 날짜로 분산(72h 이내)해도 모두 '오늘 수신' 이므로 상한에 함께 잡힌다.
    for i in range(20):
        started = (now - timedelta(hours=i * 3)).isoformat()  # 0..57h → 여러 달력일
        r = client.post(
            "/api/v1/users/me/sessions", headers=headers, json=_payload(started)
        )
        assert r.status_code == 201, (i, r.text)
    # 21번째(같은 날 수신) → 상한 초과 422
    started = (now - timedelta(hours=5)).isoformat()
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=_payload(started))
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"


# ── C1: sets[] setIndex 중복 → 422 (500 아님) ────────────────────
def test_duplicate_set_index_rejected(client):
    _, headers = register_and_auth(client)
    payload = _payload(datetime.now(timezone.utc).isoformat())
    payload["sets"] = [
        {"setIndex": 0, "reps": 5},
        {"setIndex": 0, "reps": 6},  # 중복
    ]
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"


# ── C2: 존재하지 않는 deviceId → 422 (FK 위반/500 아님) ──────────
def test_unknown_device_id_rejected(client):
    _, headers = register_and_auth(client)
    payload = _payload(datetime.now(timezone.utc).isoformat())
    payload["deviceId"] = str(uuid.uuid4())  # 존재하지 않는 디바이스
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"
    assert r.json()["error"]["details"]["field"] == "deviceId"


# ── C3: score 상한 초과 → 422 ────────────────────────────────────
def test_score_above_cap_rejected(client):
    _, headers = register_and_auth(client)
    payload = _payload(datetime.now(timezone.utc).isoformat(), score=501)
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"
