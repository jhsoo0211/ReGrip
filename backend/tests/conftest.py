"""pytest 공용 설정.

앱 임포트 **전에** 환경변수를 설정해 in-memory SQLite(StaticPool 공유 연결)를 쓰게 한다.
각 테스트마다 스키마를 리셋하고 업적 6종을 시딩한다.
"""
from __future__ import annotations

import os

# ── 반드시 src 임포트 전에 설정 ──
os.environ["DATABASE_URL"] = "sqlite://"  # in-memory (db.py 가 StaticPool 로 공유)
os.environ["ENV"] = "test"
os.environ.setdefault("JWT_SECRET", "test-secret-key")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src.core.db import SessionLocal, engine  # noqa: E402
from src.main import app  # noqa: E402
from src.models import Base  # noqa: E402
from src.services.achievements import seed_achievements  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_achievements(db)
    finally:
        db.close()
    with TestClient(app) as c:
        yield c


# ── 헬퍼 ────────────────────────────────────────────────────────
def signup(client, email="patient@example.com", password="password123",
           name="홍길동", birth_date="1990-05-01", guardian=None):
    return client.post(
        "/api/v1/auth/signup",
        json={
            "email": email,
            "password": password,
            "profile": {"name": name, "birthDate": birth_date},
            "consents": {
                "sensitiveData": True,
                "termsOfService": True,
                "guardianConsent": guardian,
            },
        },
    )


def register_and_auth(client, **kwargs):
    """회원가입 후 (access token, auth headers) 반환."""
    resp = signup(client, **kwargs)
    assert resp.status_code == 201, resp.text
    token = resp.json()["accessToken"]
    return token, {"Authorization": f"Bearer {token}"}
