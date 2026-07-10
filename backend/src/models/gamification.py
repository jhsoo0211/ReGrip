"""achievement_definitions / user_achievements / xp_events / user_stats (01-erd.md §4).

user_stats.streak_bonus_awarded_for_run 은 [MVP 추가] 컬럼: 7일 연속 보너스(+200)를
streak run 당 1회만 지급하기 위한 플래그(03 §1). streak 가 끊기면 false 로 리셋된다.
001_init.sql 에도 동일 주석과 함께 추가되어 있다.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..core.types import GUID, JSONB
from .base import Base, TimestampMixin


class AchievementDefinition(Base, TimestampMixin):
    __tablename__ = "achievement_definitions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)  # 슬러그
    title: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(24), nullable=False)
    rarity: Mapped[str] = mapped_column(String(16), nullable=False)
    reward_xp: Mapped[int] = mapped_column(Integer, nullable=False)
    rule_type: Mapped[str] = mapped_column(String(24), nullable=False)
    rule_params = mapped_column(JSONB, nullable=False, default=dict)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)

    __table_args__ = (
        CheckConstraint(
            "category IN ('game_play','grip_training','persistence','collection')",
            name="ck_ach_category",
        ),
        CheckConstraint(
            "rarity IN ('common','rare','epic','legendary')", name="ck_ach_rarity"
        ),
        CheckConstraint("reward_xp BETWEEN 100 AND 500", name="ck_ach_reward"),
        CheckConstraint(
            "rule_type IN ('session_count','max_force_gte','streak_days','total_sets')",
            name="ck_ach_rule_type",
        ),
    )


class UserAchievement(Base, TimestampMixin):
    __tablename__ = "user_achievements"

    user_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    achievement_id: Mapped[str] = mapped_column(
        Text, ForeignKey("achievement_definitions.id"), primary_key=True
    )
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    target: Mapped[int] = mapped_column(Integer, nullable=False)
    unlocked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class XpEvent(Base):
    __tablename__ = "xp_events"

    # bigint IDENTITY append-only 원장(ledger). SQLite 는 INTEGER autoincrement 폴백.
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    amount: Mapped[int] = mapped_column(Integer, nullable=False)
    reason: Mapped[str] = mapped_column(String(24), nullable=False)
    ref_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    ref_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )

    __table_args__ = (
        CheckConstraint(
            "reason IN ('session','achievement','streak_bonus','goal_bonus')",
            name="ck_xp_reason",
        ),
    )


class UserStats(Base):
    __tablename__ = "user_stats"

    user_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    total_xp: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # =SUM(xp_events)
    level: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    tier: Mapped[str] = mapped_column(Text, nullable=False, default="beginner")
    current_streak: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    longest_streak: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_session_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    total_sessions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    best_max_force: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    # [MVP 추가] 7일 연속 보너스 중복 지급 방지 플래그 (streak run 당 1회)
    streak_bonus_awarded_for_run: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
