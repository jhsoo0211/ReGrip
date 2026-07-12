"""4게임 동기화 회귀: rhythm/glide 신규 exerciseType + crane 새 임계 [3,5].

프론트 GAME_DEFS.starThresholds 와 서버 STAR_THRESHOLDS 일치를 실 HTTP 왕복으로 검증한다.
고정 날짜 금지: 서버의 72h 백데이트 하한 때문에 매번 '1시간 전'을 계산한다(_recent_started_at).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from tests.conftest import register_and_auth


def _recent_started_at() -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _payload(exercise_type, score, *, csid=None, avg=50.0, mx=60.0):
    return {
        "clientSessionId": csid or str(uuid.uuid4()),
        "exerciseType": exercise_type,
        "startedAt": _recent_started_at(),
        "durationSec": 120,
        "score": score,
        "avgForce": avg,
        "maxForce": mx,
        "attempts": score,
    }


def test_rhythm_session_stars_label_and_unlock(client):
    # rhythm [14,20]: score 20 → ★3, label "리듬 펌프 게임", first_rhythm 언락.
    _, headers = register_and_auth(client)
    r = client.post(
        "/api/v1/users/me/sessions", headers=headers, json=_payload("game_rhythm", 20)
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["session"]["stars"] == 3
    assert body["session"]["label"] == "리듬 펌프 게임"
    unlocked_ids = {a["id"] for a in body["unlockedAchievements"]}
    assert "first_rhythm" in unlocked_ids
    # 별3 세션이라 three_star 도 함께 언락된다(게임 무관 조건).
    assert unlocked_ids == {"first_rhythm", "three_star"}


def test_glide_session_star_thresholds(client):
    # glide [15,24]: score 14 → ★1 (15 미만), score 24 → ★3.
    _, headers = register_and_auth(client)

    r1 = client.post(
        "/api/v1/users/me/sessions", headers=headers, json=_payload("game_glide", 14)
    )
    assert r1.status_code == 201, r1.text
    b1 = r1.json()
    assert b1["session"]["stars"] == 1
    assert b1["session"]["label"] == "잠수함 게임"
    # first_glide 는 세트≥1 이면 언락 (score 14 = set_count 14).
    assert "first_glide" in {a["id"] for a in b1["unlockedAchievements"]}

    r2 = client.post(
        "/api/v1/users/me/sessions", headers=headers, json=_payload("game_glide", 24)
    )
    assert r2.status_code == 201, r2.text
    assert r2.json()["session"]["stars"] == 3


def test_crane_new_star_thresholds(client):
    # crane [3,5]: score 3 → ★2, score 5 → ★3 (기존 [4,8] 에서 완화).
    _, headers = register_and_auth(client)

    r1 = client.post(
        "/api/v1/users/me/sessions", headers=headers, json=_payload("game_crane", 3)
    )
    assert r1.status_code == 201, r1.text
    assert r1.json()["session"]["stars"] == 2
    assert r1.json()["session"]["label"] == "크레인 게임"

    r2 = client.post(
        "/api/v1/users/me/sessions", headers=headers, json=_payload("game_crane", 5)
    )
    assert r2.status_code == 201, r2.text
    assert r2.json()["session"]["stars"] == 3
