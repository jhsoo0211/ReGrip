"""회귀: 순서무관 streak 재계산 + 7일 보너스(B1/B2), 읽기 시 감쇠(B3)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import jwt

from src.core.config import settings
from src.core.db import SessionLocal
from src.models import UserStats
from tests.conftest import register_and_auth


def _submit_days(client, headers, day_offsets, score=10):
    """day_offsets(오늘로부터 며칠 전) 순서대로 세션을 제출한다. game_balloon score=10 → 별3."""
    now = datetime.now(timezone.utc)
    for k in day_offsets:
        started = (now - timedelta(days=k)).isoformat()
        payload = {
            "clientSessionId": str(uuid.uuid4()),
            "exerciseType": "game_balloon",
            "startedAt": started,
            "durationSec": 300,
            "score": score,
            "avgForce": 60.0,
            "maxForce": 85.0,
        }
        r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
        assert r.status_code == 201, (k, r.text)


def test_streak_order_independent_with_bonus_and_achievement(client, monkeypatch):
    # 7일 연속을 만들려면 최대 6일 백데이트가 필요하므로 이 테스트에서만 하한을 완화한다.
    monkeypatch.setattr(settings, "backdate_limit_hours", 24 * 30)

    # 사용자 A: 역순 제출 (오늘 → 6일 전)
    _, ha = register_and_auth(client, email="rev@example.com")
    _submit_days(client, ha, [0, 1, 2, 3, 4, 5, 6])
    stats_a = client.get("/api/v1/users/me/stats", headers=ha).json()

    # 사용자 B: 정순 제출 (6일 전 → 오늘)
    _, hb = register_and_auth(client, email="fwd@example.com")
    _submit_days(client, hb, [6, 5, 4, 3, 2, 1, 0])
    stats_b = client.get("/api/v1/users/me/stats", headers=hb).json()

    # 순서와 무관하게 연속 7일 → currentStreak 7
    assert stats_a["currentStreak"] == 7, stats_a
    assert stats_b["currentStreak"] == 7, stats_b
    # 역순/정순 totalXp 동일 (순서 불변)
    assert stats_a["totalXp"] == stats_b["totalXp"]

    # 7일 보너스 200 이 정확히 1회 지급
    ev = client.get("/api/v1/users/me/xp-events?limit=100", headers=ha).json()["data"]
    bonuses = [e for e in ev if e["reason"] == "streak_bonus"]
    assert len(bonuses) == 1 and bonuses[0]["amount"] == 200, ev

    # consistency_king(7일 연속) 해금
    ach = client.get("/api/v1/users/me/achievements", headers=ha).json()["data"]
    ck = next(a for a in ach if a["id"] == "consistency_king")
    assert ck["unlockedAt"] is not None, ck


def test_effective_streak_decays_when_last_session_stale(client):
    token, headers = register_and_auth(client, email="stale@example.com")
    uid = jwt.decode(token, options={"verify_signature": False})["sub"]

    # 저장값은 7 이지만 마지막 세션일이 아주 오래된 상태 → 읽기 시 currentStreak 0 (B3).
    db = SessionLocal()
    try:
        st = db.get(UserStats, uid)
        st.current_streak = 7
        st.longest_streak = 9
        st.last_session_date = date(2020, 1, 1)
        db.commit()
    finally:
        db.close()

    r = client.get("/api/v1/users/me/stats", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["currentStreak"] == 0, body  # 감쇠
    assert body["longestStreak"] == 9, body  # 저장값(longest)은 유지
