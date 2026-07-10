"""users / profiles / user_settings 모델 (01-erd.md §1)."""
from __future__ import annotations

import uuid
from datetime import date, datetime, time

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    Time,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..core.types import GUID, CIText
from .base import Base, TimestampMixin


def _uuid() -> str:
    return str(uuid.uuid4())


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(GUID, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(CIText(320), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)  # argon2id
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="patient")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    profile: Mapped["Profile"] = relationship(back_populates="user", uselist=False)
    settings: Mapped["UserSettings"] = relationship(back_populates="user", uselist=False)

    __table_args__ = (
        CheckConstraint("role IN ('patient','therapist','admin')", name="ck_users_role"),
        CheckConstraint("status IN ('active','deleted')", name="ck_users_status"),
    )


class Profile(Base, TimestampMixin):
    __tablename__ = "profiles"

    user_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    birth_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    gender: Mapped[str | None] = mapped_column(String(16), nullable=True)
    phone_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)  # AES-GCM
    dominant_hand: Mapped[str | None] = mapped_column(String(8), nullable=True)
    injury_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    treatment_start: Mapped[date | None] = mapped_column(Date, nullable=True)
    doctor_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    goal_force: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    goal_days: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # base64 금지, URL 만

    user: Mapped[User] = relationship(back_populates="profile")

    __table_args__ = (
        CheckConstraint(
            "gender IN ('male','female','other','unspecified')", name="ck_profiles_gender"
        ),
        CheckConstraint(
            "dominant_hand IN ('left','right','both')", name="ck_profiles_hand"
        ),
        CheckConstraint(
            "injury_type IN ('fracture','tendon','nerve','arthritis','stroke','other')",
            name="ck_profiles_injury",
        ),
        CheckConstraint(
            "goal_force IS NULL OR (goal_force BETWEEN 10 AND 100)", name="ck_profiles_goal_force"
        ),
        CheckConstraint(
            "goal_days IS NULL OR goal_days IN (3,4,5,7)", name="ck_profiles_goal_days"
        ),
    )


class UserSettings(Base, TimestampMixin):
    __tablename__ = "user_settings"

    user_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    hand: Mapped[str | None] = mapped_column(String(8), nullable=True)
    difficulty: Mapped[str | None] = mapped_column(String(8), nullable=True)
    rest_seconds: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=30)
    reminder_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    reminder_time: Mapped[time] = mapped_column(Time, nullable=False, default=time(9, 0))
    session_summary_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    user: Mapped[User] = relationship(back_populates="settings")

    __table_args__ = (
        CheckConstraint("hand IN ('left','right','both')", name="ck_settings_hand"),
        CheckConstraint("difficulty IN ('easy','normal','hard')", name="ck_settings_difficulty"),
        CheckConstraint("rest_seconds BETWEEN 10 AND 120", name="ck_settings_rest"),
    )
