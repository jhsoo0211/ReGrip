"""인증 라우터: signup / login / refresh / logout (02-api-spec §2).

Access JWT(30분) + Refresh(14일, 회전) 쿠키. Refresh 는 DB 에 해시 저장하고 회전 시 무효화한다.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select

from ..core.config import settings
from ..core.db import get_db
from ..core.errors import AppError
from ..core.security import (
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    refresh_expiry,
    verify_password,
)
from ..models import Profile, RefreshToken, User, UserSettings, UserStats
from ..schemas.auth import LoginRequest, SignupRequest, TokenResponse, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "refresh_token"


def _compute_age(bd: date | None) -> int | None:
    if bd is None:
        return None
    today = date.today()
    return today.year - bd.year - ((today.month, today.day) < (bd.month, bd.day))


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE,
        value=raw_token,
        httponly=True,
        secure=settings.is_prod,  # prod 에서만 Secure
        samesite="strict",
        max_age=settings.refresh_token_days * 24 * 3600,
        path="/",
    )


def _issue_refresh(db, user_id: str, replaced_from: RefreshToken | None = None) -> str:
    """새 refresh 토큰 발급 + DB 저장. 회전 시 이전 토큰을 무효화하고 체인 연결. 반환: 원문 토큰."""
    raw = generate_refresh_token()
    rt = RefreshToken(
        user_id=user_id,
        token_hash=hash_refresh_token(raw),
        expires_at=refresh_expiry(),
    )
    db.add(rt)
    db.flush()
    if replaced_from is not None:
        replaced_from.revoked_at = datetime.now(timezone.utc)
        replaced_from.replaced_by = rt.id
    return raw


def _token_response(db, user: User, response: Response) -> TokenResponse:
    access = create_access_token(user.id, user.role)
    raw_refresh = _issue_refresh(db, user.id)
    db.commit()
    _set_refresh_cookie(response, raw_refresh)
    return TokenResponse(
        access_token=access,
        expires_in=settings.access_token_minutes * 60,
        user=UserOut(id=user.id, email=user.email, role=user.role),
    )


@router.post("/signup", status_code=201, response_model=TokenResponse)
def signup(body: SignupRequest, response: Response, db=Depends(get_db)):
    # 민감정보/약관 동의 필수 (06-security-compliance)
    if not body.consents.sensitive_data:
        raise AppError(
            422, "VALIDATION_FAILED", "민감정보 처리 동의가 필요합니다.", {"field": "sensitiveData"}
        )
    if not body.consents.terms_of_service:
        raise AppError(
            422, "VALIDATION_FAILED", "이용약관 동의가 필요합니다.", {"field": "termsOfService"}
        )
    # 만 14세 미만 법정대리인 동의
    age = _compute_age(body.profile.birth_date)
    if age is not None and age < 14 and not body.consents.guardian_consent:
        raise AppError(
            422,
            "VALIDATION_FAILED",
            "만 14세 미만은 법정대리인 동의가 필요합니다.",
            {"field": "guardianConsent"},
        )

    email = body.email.lower()
    exists = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if exists is not None:
        raise AppError(409, "CONFLICT", "이미 가입된 이메일입니다.", {"field": "email"})

    user = User(email=email, password_hash=hash_password(body.password), role="patient")
    db.add(user)
    db.flush()
    db.add(Profile(user_id=user.id, name=body.profile.name, birth_date=body.profile.birth_date))
    db.add(UserSettings(user_id=user.id))
    db.add(UserStats(user_id=user.id))
    db.flush()

    return _token_response(db, user, response)


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, response: Response, db=Depends(get_db)):
    email = body.email.lower()
    user = db.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if user is None or user.status != "active" or not verify_password(body.password, user.password_hash):
        raise AppError(401, "UNAUTHENTICATED", "이메일 또는 비밀번호가 올바르지 않습니다.")
    return _token_response(db, user, response)


@router.post("/refresh", response_model=TokenResponse)
def refresh(request: Request, response: Response, db=Depends(get_db)):
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise AppError(401, "UNAUTHENTICATED", "refresh 토큰이 없습니다.")
    token_hash = hash_refresh_token(raw)
    rt = db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    ).scalar_one_or_none()
    if rt is None:
        raise AppError(401, "UNAUTHENTICATED", "유효하지 않은 refresh 토큰입니다.")

    now = datetime.now(timezone.utc)
    # 재사용 탐지: 이미 회전/폐기된 토큰이 다시 오면 체인 전체 무효화
    if rt.revoked_at is not None:
        _revoke_all(db, rt.user_id)
        db.commit()
        raise AppError(401, "UNAUTHENTICATED", "재사용된 refresh 토큰입니다.")
    expires_at = rt.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < now:
        raise AppError(401, "UNAUTHENTICATED", "만료된 refresh 토큰입니다.")

    user = db.get(User, rt.user_id)
    if user is None or user.status != "active":
        raise AppError(401, "UNAUTHENTICATED", "사용자를 찾을 수 없습니다.")

    access = create_access_token(user.id, user.role)
    raw_refresh = _issue_refresh(db, user.id, replaced_from=rt)  # 회전
    db.commit()
    _set_refresh_cookie(response, raw_refresh)
    return TokenResponse(
        access_token=access,
        expires_in=settings.access_token_minutes * 60,
        user=UserOut(id=user.id, email=user.email, role=user.role),
    )


@router.post("/logout")
def logout(request: Request, response: Response, db=Depends(get_db)):
    raw = request.cookies.get(REFRESH_COOKIE)
    if raw:
        token_hash = hash_refresh_token(raw)
        rt = db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        ).scalar_one_or_none()
        if rt is not None and rt.revoked_at is None:
            rt.revoked_at = datetime.now(timezone.utc)
            db.commit()
    response.delete_cookie(REFRESH_COOKIE, path="/")
    return {"ok": True}


def _revoke_all(db, user_id: str) -> None:
    rows = db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None)
        )
    ).scalars().all()
    for r in rows:
        r.revoked_at = datetime.now(timezone.utc)
