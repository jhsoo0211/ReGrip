"""API 공통 의존성: 현재 사용자(Bearer access JWT)."""
from __future__ import annotations

import jwt
from fastapi import Depends, Request

from ..core.db import get_db
from ..core.errors import AppError
from ..core.security import decode_access_token
from ..models import User


def get_current_user(request: Request, db=Depends(get_db)) -> User:
    auth = request.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        raise AppError(401, "UNAUTHENTICATED", "인증 토큰이 필요합니다.")
    token = auth.split(" ", 1)[1].strip()
    try:
        payload = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        raise AppError(401, "UNAUTHENTICATED", "토큰이 만료되었습니다.")
    except jwt.InvalidTokenError:
        raise AppError(401, "UNAUTHENTICATED", "유효하지 않은 토큰입니다.")
    if payload.get("type") != "access":
        raise AppError(401, "UNAUTHENTICATED", "유효하지 않은 토큰입니다.")
    user = db.get(User, payload.get("sub"))
    if user is None or user.status != "active":
        raise AppError(401, "UNAUTHENTICATED", "사용자를 찾을 수 없습니다.")
    return user
