"""설정 스키마 (02-api-spec §3.4)."""
from __future__ import annotations

from pydantic import Field, field_validator

from .base import CamelModel
from .provenance import Difficulty, Hand, normalize_difficulty


class SettingsOut(CamelModel):
    hand: str | None = None
    difficulty: str | None = None
    rest_seconds: int = 30
    reminder_enabled: bool = True
    reminder_time: str = "09:00"  # HH:MM
    session_summary_enabled: bool = True
    timezone: str = "Asia/Seoul"  # IANA tz


class SettingsUpdate(CamelModel):
    hand: Hand | None = None
    difficulty: Difficulty | None = None
    rest_seconds: int | None = Field(default=None, ge=10, le=120)
    reminder_enabled: bool | None = None
    reminder_time: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    session_summary_enabled: bool | None = None
    timezone: str | None = None  # IANA tz (유효성은 라우터에서 검증, 무효 시 422)

    _difficulty_alias = field_validator("difficulty", mode="before")(normalize_difficulty)
