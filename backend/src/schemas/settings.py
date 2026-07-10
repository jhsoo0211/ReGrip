"""설정 스키마 (02-api-spec §3.4)."""
from __future__ import annotations

from pydantic import Field

from .base import CamelModel


class SettingsOut(CamelModel):
    hand: str | None = None
    difficulty: str | None = None
    rest_seconds: int = 30
    reminder_enabled: bool = True
    reminder_time: str = "09:00"  # HH:MM
    session_summary_enabled: bool = True
    timezone: str = "Asia/Seoul"  # IANA tz


class SettingsUpdate(CamelModel):
    hand: str | None = None
    difficulty: str | None = None
    rest_seconds: int | None = Field(default=None, ge=10, le=120)
    reminder_enabled: bool | None = None
    reminder_time: str | None = None
    session_summary_enabled: bool | None = None
    timezone: str | None = None  # IANA tz (유효성은 라우터에서 검증, 무효 시 422)
