"""세션 스키마 (02-api-spec §4)."""
from __future__ import annotations

from datetime import datetime

from pydantic import Field

from .base import CamelModel


class SessionSetIn(CamelModel):
    set_index: int
    reps: int | None = None
    avg_force: float | None = Field(default=None, ge=0, le=100)
    peak_force: float | None = Field(default=None, ge=0, le=100)
    hold_sec: int | None = Field(default=None, ge=0)


class SessionCreate(CamelModel):
    client_session_id: str
    exercise_type: str
    started_at: datetime
    duration_sec: int = Field(gt=0)
    score: int = Field(ge=0)  # = set_count
    avg_force: float = Field(ge=0, le=100)
    max_force: float = Field(ge=0, le=100)
    attempts: int = Field(default=0, ge=0)
    difficulty: str | None = None
    hand_used: str | None = None
    device_id: str | None = None
    force_series: list[float] | None = None
    sets: list[SessionSetIn] | None = None
    # stars 는 보내도 무시된다 (서버 재계산). 필드 자체는 받아 삼킨다.
    stars: int | None = None


class SessionSetOut(CamelModel):
    set_index: int
    reps: int | None = None
    avg_force: float | None = None
    peak_force: float | None = None
    hold_sec: int | None = None


class SessionSummary(CamelModel):
    """목록/POST 응답의 세션 요약 (durationMin/sets/label 유도)."""

    id: str
    client_session_id: str | None = None
    date: str  # started_at (ISO UTC 'Z')
    exercise_type: str
    label: str
    duration_min: int
    sets: int
    avg_force: float
    max_force: float
    stars: int


class SessionDetail(CamelModel):
    id: str
    exercise_type: str
    label: str
    started_at: str  # ISO UTC 'Z'
    duration_min: int
    set_count: int  # 게임 스코어(정수). 목록의 sets 와 동일 값
    avg_force: float
    max_force: float
    stars: int
    force_series: list[float] | None = None
    # 02 §4.3: 세트 상세 배열. 프론트가 세트를 보냈을 때만 채워진다.
    sets: list[SessionSetOut] = []


class UnlockedAchievement(CamelModel):
    id: str
    title: str
    reward_xp: int
    rarity: str


class SessionCreateResponse(CamelModel):
    session: SessionSummary
    xp_awarded: int
    total_xp: int
    level: int
    level_up: bool
    unlocked_achievements: list[UnlockedAchievement] = []


class SessionListMeta(CamelModel):
    next_cursor: str | None = None
    limit: int


class SessionListResponse(CamelModel):
    data: list[SessionSummary]
    meta: SessionListMeta
