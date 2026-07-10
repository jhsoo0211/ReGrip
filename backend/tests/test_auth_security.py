"""회귀: refresh 재사용 탐지 시 유저의 활성 refresh 전부 폐기(D1) + 로그인 타이밍 완화(D2)."""
from __future__ import annotations

from tests.conftest import signup


def test_refresh_reuse_revokes_all_active_tokens(client):
    r = signup(client, email="d1@example.com")
    assert r.status_code == 201
    r0 = client.cookies.get("refresh_token")  # 최초 발급
    assert r0

    # 정상 회전: r0 → r1
    resp = client.post("/api/v1/auth/refresh")
    assert resp.status_code == 200, resp.text
    r1 = client.cookies.get("refresh_token")
    assert r1 and r1 != r0

    # 구 토큰 r0 재사용 → 401 (재사용 탐지)
    client.cookies.clear()
    resp = client.post("/api/v1/auth/refresh", cookies={"refresh_token": r0})
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"

    # 재사용 탐지로 현재 유효하던 r1 까지 전부 폐기되어야 한다 → r1 로도 401
    client.cookies.clear()
    resp = client.post("/api/v1/auth/refresh", cookies={"refresh_token": r1})
    assert resp.status_code == 401, resp.text
    assert resp.json()["error"]["code"] == "UNAUTHENTICATED"


def test_login_unknown_email_returns_same_error(client):
    # D2: 존재하지 않는 계정도(더미 해시 검증 경유) 동일한 401 코드를 반환한다.
    r = client.post(
        "/api/v1/auth/login",
        json={"email": "nobody@example.com", "password": "password123"},
    )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHENTICATED"
