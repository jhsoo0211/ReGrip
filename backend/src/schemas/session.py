"""세션 스키마 (02-api-spec §4)."""
from __future__ import annotations

from datetime import datetime

from pydantic import Field, field_validator, model_validator

from .base import CamelModel
from .provenance import (
    CalibrationSnapshot, Difficulty, ForcePercent, Hand, InputSource, UUIDString, normalize_difficulty,
)


class SessionSetIn(CamelModel):
    set_index: int = Field(ge=0, le=32767)
    reps: int | None = Field(default=None, ge=0, le=32767)
    avg_force: ForcePercent | None = None
    peak_force: ForcePercent | None = None
    hold_sec: int | None = Field(default=None, ge=0, le=2147483647)

    @model_validator(mode="after")
    def validate_peak(self):
        if self.avg_force is not None and self.peak_force is not None and self.avg_force > self.peak_force:
            raise ValueError("세트 avgForce는 peakForce 이하여야 합니다.")
        return self


class SessionCreate(CamelModel):
    client_session_id: UUIDString
    exercise_type: str
    started_at: datetime
    duration_sec: int = Field(gt=0, le=2147483647)
    # score(=set_count)/attempts 상한: SMALLINT 오버플로 및 단일 제출 업적 파밍 차단.
    score: int = Field(ge=0, le=500)  # = set_count
    avg_force: ForcePercent
    max_force: ForcePercent
    attempts: int = Field(default=0, ge=0, le=1000)
    difficulty: Difficulty | None = None
    hand_used: Hand | None = None
    device_id: UUIDString | None = None
    input_source: InputSource = "unknown"
    calibration_snapshot: CalibrationSnapshot | None = None
    # 1Hz 다운샘플 시계열 길이 상한(약 1시간). 과대 페이로드 차단.
    force_series: list[ForcePercent] | None = Field(default=None, max_length=3600)
    sets: list[SessionSetIn] | None = Field(default=None, max_length=1000)
    # stars 는 보내도 무시된다 (서버 재계산). 필드 자체는 받아 삼킨다.
    stars: int | None = None

    _difficulty_alias = field_validator("difficulty", mode="before")(normalize_difficulty)

    @model_validator(mode="after")
    def validate_provenance(self):
        if self.input_source == "ble" and self.calibration_snapshot is None:
            raise ValueError("BLE 세션에는 calibrationSnapshot이 필요합니다.")
        if self.input_source != "ble" and self.calibration_snapshot is not None:
            raise ValueError("calibrationSnapshot은 BLE 세션에만 사용할 수 있습니다.")
        return self

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
    input_source: InputSource = "unknown"
    calibration_snapshot: CalibrationSnapshot | None = None


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
    input_source: InputSource = "unknown"
    calibration_snapshot: CalibrationSnapshot | None = None
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
