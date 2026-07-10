"""devices / calibrations 모델 (01-erd.md §2).

devices.org_id 는 B2B organizations 를 참조하지만, MVP ORM 에서는 organizations 모델을
선언하지 않으므로 여기서는 FK 없이 GUID 컬럼으로만 둔다(운영 스키마 001_init.sql 에는 FK 존재).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..core.types import GUID
from .base import Base, TimestampMixin


def _uuid() -> str:
    return str(uuid.uuid4())


class Device(Base, TimestampMixin):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(GUID, primary_key=True, default=_uuid)
    serial_no: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    firmware_version: Mapped[str | None] = mapped_column(Text, nullable=True)
    owner_user_id: Mapped[str | None] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    org_id: Mapped[str | None] = mapped_column(GUID, nullable=True)  # B2B (FK in SQL only)
    paired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Calibration(Base, TimestampMixin):
    __tablename__ = "calibrations"

    # bigint IDENTITY (append-only 로그). SQLite 는 INTEGER autoincrement 로 폴백.
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    device_id: Mapped[str | None] = mapped_column(
        GUID, ForeignKey("devices.id", ondelete="SET NULL"), nullable=True
    )
    baseline_raw_0: Mapped[float] = mapped_column(Float, nullable=False)
    baseline_raw_100: Mapped[float] = mapped_column(Float, nullable=False)
    calibrated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
