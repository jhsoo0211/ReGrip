"""케이스 1: 회원가입→로그인→보호 라우트, refresh 회전(구 refresh 재사용→401), logout 후 refresh 불가."""
from __future__ import annotations

from tests.conftest import signup


def test_signup_login_protected_route_and_refresh_rotation(client):
    # 회원가입
    r = signup(client)
    assert r.status_code == 201, r.text
    assert "accessToken" in r.json()

    # 로그인
    r = client.post(
        "/api/v1/auth/login",
        json={"email": "patient@example.com", "password": "password123"},
    )
    assert r.status_code == 200, r.text
    access = r.json()["accessToken"]
    assert client.cookies.get("refresh_token")

    # 보호 라우트 접근 (Bearer)
    r = client.get("/api/v1/users/me/profile", headers={"Authorization": f"Bearer {access}"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "홍길동"

    # 토큰 없이 접근 → 401 + envelope
    r = client.get("/api/v1/users/me/profile")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHENTICATED"

    # refresh 회전
    old_refresh = client.cookies.get("refresh_token")
    r = client.post("/api/v1/auth/refresh")
    assert r.status_code == 200, r.text
    assert "accessToken" in r.json()
    new_refresh = client.cookies.get("refresh_token")
    assert new_refresh and new_refresh != old_refresh

    # 구 refresh 재사용 → 401
    client.cookies.clear()
    r = client.post("/api/v1/auth/refresh", cookies={"refresh_token": old_refresh})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "UNAUTHENTICATED"


def test_logout_revokes_refresh(client):
    signup(client, email="logout@example.com")
    r = client.post(
        "/api/v1/auth/login",
        json={"email": "logout@example.com", "password": "password123"},
    )
    assert r.status_code == 200
    refresh_token = client.cookies.get("refresh_token")

    # 로그아웃 → refresh 폐기
    r = client.post("/api/v1/auth/logout")
    assert r.status_code == 200

    # 폐기된 refresh 로 재발급 시도 → 401
    client.cookies.clear()
    r = client.post("/api/v1/auth/refresh", cookies={"refresh_token": refresh_token})
    assert r.status_code == 401


def test_duplicate_email_conflict(client):
    assert signup(client, email="dup@example.com").status_code == 201
    r = signup(client, email="dup@example.com")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "CONFLICT"


def test_signup_requires_sensitive_consent(client):
    r = client.post(
        "/api/v1/auth/signup",
        json={
            "email": "noconsent@example.com",
            "password": "password123",
            "profile": {"name": "무동의", "birthDate": "1990-01-01"},
            "consents": {"sensitiveData": False, "termsOfService": True},
        },
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"
