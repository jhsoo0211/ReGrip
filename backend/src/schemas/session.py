"""세션 스키마 (02-api-spec §4)."""
from __future__ import annotations

from datetime import datetime

from pydantic import Field, model_validator

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
    # score(=set_count)/attempts 상한: SMALLINT 오버플로 및 단일 제출 업적 파밍 차단.
    score: int = Field(ge=0, le=500)  # = set_count
    avg_force: float = Field(ge=0, le=100)
    max_force: float = Field(ge=0, le=100)
    attempts: int = Field(default=0, ge=0, le=1000)
    difficulty: str | None = None
    hand_used: str | None = None
    device_id: str | None = None
    # 1Hz 다운샘플 시계열 길이 상한(약 1시간). 과대 페이로드 차단.
    force_series: list[float] | None = Field(default=None, max_length=3600)
    sets: list[SessionSetIn] | None = None
    # stars 는 보내도 무시된다 (서버 재계산). 필드 자체는 받아 삼킨다.
    stars: int | None = None

    @model_validator(mode="after")
    def _no_duplicate_set_index(self):
        """sets[] 의 setIndex 중복은 uq_session_sets 위반(500) 이전에 422 로 거부한다 (C1)."""
        if self.sets:
            seen: set[int] = set()
            for st in self.sets:
                if st.set_index in seen:
                    raise ValueError("중복된 setIndex 입니다.")
                seen.add(st.set_index)
        return self


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
