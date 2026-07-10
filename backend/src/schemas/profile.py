"""프로필 스키마 (02-api-spec §3.1, §3.2)."""
from __future__ import annotations

from datetime import date

from pydantic import Field

from .base import CamelModel


class ProfileOut(CamelModel):
    name: str | None = None
    age: int | None = None  # birthDate 에서 유도
    birth_date: date | None = None
    gender: str | None = None
    phone: str | None = None  # 복호화된 값
    hand: str | None = None  # dominant_hand
    injury_type: str | None = None
    treatment_start: date | None = None
    doctor_name: str | None = None
    goal_force: int | None = None
    goal_days: int | None = None
    avatar_url: str | None = None


class ProfileUpdate(CamelModel):
    """PUT: 부분 업데이트. 보내진 필드만 반영. avatarBase64 과도기 호환."""

    name: str | None = None
    birth_date: date | None = None
    gender: str | None = None
    phone: str | None = None
    hand: str | None = None
    injury_type: str | None = None
    treatment_start: date | None = None
    doctor_name: str | None = None
    goal_force: int | None = Field(default=None, ge=10, le=100)
    goal_days: int | None = None
    avatar_base64: str | None = None  # data URL — 서버가 디코드/저장 후 avatar_url 로 치환


class AvatarOut(CamelModel):
    avatar_url: str
