"""케이스 6: 커서 페이지네이션 (25건 → 20 + 5, nextCursor 동작)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time, timedelta

from tests.conftest import register_and_auth


def test_cursor_pagination_25_sessions(client):
    _, headers = register_and_auth(client)

    # 서로 다른 날짜로 25건 저장 (일일 상한 20 회피 + startedAt 유일)
    base = date(2026, 6, 1)
    for i in range(25):
        started = datetime.combine(base + timedelta(days=i), time(10, 0)).isoformat() + "Z"
        payload = {
            "clientSessionId": str(uuid.uuid4()),
            "exerciseType": "game_balloon",
            "startedAt": started,
            "durationSec": 300,
            "score": 5,
            "avgForce": 40.0,
            "maxForce": 60.0,
        }
        r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload)
        assert r.status_code == 201, r.text

    # 1페이지: 20건 + nextCursor
    r = client.get("/api/v1/users/me/sessions?limit=20", headers=headers)
    assert r.status_code == 200
    page1 = r.json()
    assert len(page1["data"]) == 20
    cursor = page1["meta"]["nextCursor"]
    assert cursor

    # 최신순(started_at DESC): 첫 항목은 6/25
    assert page1["data"][0]["date"].startswith("2026-06-25")

    # 2페이지: 5건 + nextCursor 없음
    r = client.get(f"/api/v1/users/me/sessions?limit=20&cursor={cursor}", headers=headers)
    assert r.status_code == 200
    page2 = r.json()
    assert len(page2["data"]) == 5
    assert page2["meta"]["nextCursor"] is None

    # 페이지 간 중복 없음
    ids1 = {s["id"] for s in page1["data"]}
    ids2 = {s["id"] for s in page2["data"]}
    assert ids1.isdisjoint(ids2)
