"""인증 프리미티브: argon2id 비밀번호 해시, JWT(access), refresh 토큰 발급/해시.

- 비밀번호: argon2id (argon2-cffi 기본 타입).
- Access JWT: HS256, payload {sub, role, exp, iat, type:'access'}. 기본 30분.
- Refresh: 무작위 URL-safe 토큰. 원문은 쿠키로만 나가고 DB 에는 sha256 해시만 저장.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

from .config import settings

_ph = PasswordHasher()


# ─── 비밀번호 ────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


# ─── Access JWT ─────────────────────────────────────────────────
def create_access_token(user_id: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": role,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_minutes),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict:
    """검증 실패 시 jwt 예외를 그대로 던진다(호출부에서 401 로 변환)."""
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


# ─── Refresh 토큰 ───────────────────────────────────────────────
def generate_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def refresh_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_days)
