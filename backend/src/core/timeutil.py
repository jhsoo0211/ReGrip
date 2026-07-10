"""시간 정규화 헬퍼.

SQLite 는 tz-aware datetime 을 온전히 저장하지 못하므로, 저장은 **naive UTC** 로 통일하고
응답 직렬화 시 'Z'(UTC) 를 붙여 내보낸다. PostgreSQL(timestamptz)에서도 UTC 저장과 일관된다.
"""
from __future__ import annotations

from datetime import datetime, timezone


def to_naive_utc(dt: datetime) -> datetime:
    """저장용: tz-aware 는 UTC 로 변환 후 tzinfo 제거. naive 는 이미 UTC 로 간주."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def as_aware_utc(dt: datetime) -> datetime:
    """비교용: naive 는 UTC 로 간주해 aware 로 승격."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso_z(dt: datetime | None) -> str | None:
    """응답 직렬화: UTC 기준 ISO 문자열 + 'Z'."""
    if dt is None:
        return None
    naive = to_naive_utc(dt) if dt.tzinfo is not None else dt
    return naive.isoformat() + "Z"


def now_naive_utc() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
