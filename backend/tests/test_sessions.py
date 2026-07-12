"""케이스 2·3·4: 세션 XP 분해 / 멱등 재제출 / stars 서버 재계산."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from tests.conftest import register_and_auth


def _recent_started_at() -> str:
    # 고정 날짜를 쓰면 서버의 72시간 백데이트 하한(A1) 때문에 시간이 지나며 깨진다.
    # '1시간 전'을 매번 계산해 미래도 아니고 72시간 이내로 항상 유효하게 만든다.
    return (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _balloon_payload(client_session_id, score=10, avg=60.0, mx=85.0):
    return {
        "clientSessionId": client_session_id,
        "exerciseType": "game_balloon",
        "startedAt": _recent_started_at(),
        "durationSec": 720,
        "score": score,
        "avgForce": avg,
        "maxForce": mx,
        "attempts": 3,
        "difficulty": "medium",
        "handUsed": "right",
    }


def test_balloon_session_xp_breakdown(client):
    _, headers = register_and_auth(client)
    csid = str(uuid.uuid4())

    r = client.post("/api/v1/users/me/sessions", headers=headers, json=_balloon_payload(csid))
    assert r.status_code == 201, r.text
    body = r.json()

    # 세션 120 + first_pop 100 + three_star 150 = 370
    assert body["xpAwarded"] == 370
    assert body["totalXp"] == 370
    assert body["level"] == 3
    assert body["levelUp"] is True
    assert body["session"]["stars"] == 3
    assert body["session"]["sets"] == 10
    assert body["session"]["label"] == "풍선 게임"

    unlocked_ids = {a["id"] for a in body["unlockedAchievements"]}
    assert unlocked_ids == {"first_pop", "three_star"}
    assert len(body["unlockedAchievements"]) == 2

    # 원장 정합: Σ xp_events == totalXp
    r = client.get("/api/v1/users/me/xp-events?limit=50", headers=headers)
    assert r.status_code == 200
    total_ledger = sum(e["amount"] for e in r.json()["data"])
    assert total_ledger == 370

    # stats 정합
    r = client.get("/api/v1/users/me/stats", headers=headers)
    assert r.status_code == 200
    stats = r.json()
    assert stats["totalXp"] == 370
    assert stats["level"] == 3
    assert stats["totalSessions"] == 1


def test_idempotent_resubmit_returns_same_body(client):
    _, headers = register_and_auth(client)
    csid = str(uuid.uuid4())

    r1 = client.post("/api/v1/users/me/sessions", headers=headers, json=_balloon_payload(csid))
    assert r1.status_code == 201
    body1 = r1.json()

    # 동일 clientSessionId 재제출 → 200 + 최초 응답과 동일 body
    r2 = client.post("/api/v1/users/me/sessions", headers=headers, json=_balloon_payload(csid))
    assert r2.status_code == 200
    assert r2.json() == body1

    # XP 중복 적립 없음
    r = client.get("/api/v1/users/me/stats", headers=headers)
    assert r.json()["totalXp"] == 370
    assert r.json()["totalSessions"] == 1

    r = client.get("/api/v1/users/me/xp-events?limit=50", headers=headers)
    assert sum(e["amount"] for e in r.json()["data"]) == 370


def test_stars_server_recomputation_ignores_client_value(client):
    _, headers = register_and_auth(client)
    csid = str(uuid.uuid4())
    payload = _balloon_payload(csid, score=3, avg=30.0, mx=50.0)
    payload["stars"] = 3  # 클라가 3을 보내도 무시되어야 한다 (balloon score 3 → 1)

    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
    assert r.status_code == 201, r.text
    assert r.json()["session"]["stars"] == 1

    # 저장된 값도 1
    session_id = r.json()["session"]["id"]
    r = client.get(f"/api/v1/users/me/sessions/{session_id}", headers=headers)
    assert r.status_code == 200
    assert r.json()["stars"] == 1
