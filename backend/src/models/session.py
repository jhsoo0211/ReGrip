"""sessions / session_sets 모델 (01-erd.md §3).

sessions.result_snapshot 은 [MVP 추가] 컬럼: 멱등 재제출 시 최초 응답(전체 body)을 그대로
돌려주기 위해 저장한다(02 §4.2, 03 §6). 001_init.sql 에도 동일 주석과 함께 추가되어 있다.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..core.types import GUID, JSONB
from .base import Base, TimestampMixin


def _uuid() -> str:
    return str(uuid.uuid4())


class Session(Base, TimestampMixin):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(GUID, primary_key=True, default=_uuid)
    client_session_id: Mapped[str] = mapped_column(GUID, nullable=False)  # 멱등키
    user_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    exercise_type: Mapped[str] = mapped_column(String(24), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    duration_sec: Mapped[int] = mapped_column(Integer, nullable=False)
    set_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    avg_force: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    max_force: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False)
    stars: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # 서버 재계산
    attempts: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    difficulty: Mapped[str | None] = mapped_column(String(8), nullable=True)
    hand_used: Mapped[str | None] = mapped_column(String(8), nullable=True)
    device_id: Mapped[str | None] = mapped_column(
        GUID, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True
    )
    calibration_id: Mapped[int | None] = mapped_column(
        ForeignKey("calibrations.id", ondelete="SET NULL"), nullable=True
    )
    force_series = mapped_column(JSONB, nullable=True)  # 1Hz 다운샘플
    # [MVP 추가] 멱등 재제출 시 최초 응답 그대로 반환하기 위한 스냅샷
    result_snapshot = mapped_column(JSONB, nullable=True)

    sets: Mapped[list["SessionSet"]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="SessionSet.set_index"
    )

    __table_args__ = (
        UniqueConstraint("user_id", "client_session_id", name="uq_sessions_idem"),
        CheckConstraint(
            "exercise_type IN ('game_crane','game_balloon','pinch_hold',"
            "'full_grip','finger_ext','lateral_grip')",
            name="ck_sessions_exercise_type",
        ),
        CheckConstraint("duration_sec > 0", name="ck_sessions_duration"),
        CheckConstraint("avg_force BETWEEN 0 AND 100", name="ck_sessions_avg_force"),
        CheckConstraint(
            "max_force BETWEEN 0 AND 100 AND max_force >= avg_force", name="ck_sessions_max_force"
        ),
        CheckConstraint("stars BETWEEN 1 AND 3", name="ck_sessions_stars"),
    )


class SessionSet(Base, TimestampMixin):
    __tablename__ = "session_sets"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    set_index: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    reps: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    avg_force: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    peak_force: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    hold_sec: Mapped[int | None] = mapped_column(Integer, nullable=True)

    session: Mapped[Session] = relationship(back_populates="sets")

    __table_args__ = (
        UniqueConstraint("session_id", "set_index", name="uq_session_sets"),
        CheckConstraint(
            "avg_force IS NULL OR (avg_force BETWEEN 0 AND 100)", name="ck_session_sets_avg"
        ),
        CheckConstraint(
            "peak_force IS NULL OR (peak_force BETWEEN 0 AND 100)", name="ck_session_sets_peak"
        ),
        CheckConstraint("hold_sec IS NULL OR hold_sec >= 0", name="ck_session_sets_hold"),
    )
