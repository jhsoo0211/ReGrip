"""SQLAlchemy 선언적 베이스 + 공통 타임스탬프 믹스인.

주의: 이 ORM 모델들은 migrations/001_init.sql (PostgreSQL DDL) 과 **수동으로 정렬**되어 있다.
자동 마이그레이션 생성이 아니므로, 스키마 변경 시 양쪽을 함께 고쳐야 한다.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utcnow,
        onupdate=_utcnow,
        server_default=func.now(),
    )
