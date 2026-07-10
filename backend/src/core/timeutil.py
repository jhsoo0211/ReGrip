"""시간 정규화 헬퍼.

SQLite 는 tz-aware datetime 을 온전히 저장하지 못하므로, 저장은 **naive UTC** 로 통일하고
응답 직렬화 시 'Z'(UTC) 를 붙여 내보낸다. PostgreSQL(timestamptz)에서도 UTC 저장과 일관된다.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from .config import settings


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


# ─── 사용자 타임존(A4) ──────────────────────────────────────────────
def resolve_zone(tz_name: str | None) -> ZoneInfo:
    """IANA tz 이름 → ZoneInfo. 무효/미지정 시 설정 기본값(Asia/Seoul) → UTC 로 폴백."""
    for candidate in (tz_name, settings.default_timezone, "UTC"):
        if not candidate:
            continue
        try:
            return ZoneInfo(candidate)
        except Exception:  # noqa: BLE001 — 무효 tz 는 다음 후보로 폴백
            continue
    return ZoneInfo("UTC")


def is_valid_timezone(tz_name: str) -> bool:
    """IANA tz 이름 유효성. 설정 API 의 timezone 필드 검증(잘못된 값 422)에 사용."""
    try:
        ZoneInfo(tz_name)
        return True
    except Exception:  # noqa: BLE001
        return False


def to_user_date(dt: datetime, zone: ZoneInfo) -> date:
    """저장된(naive UTC 또는 aware) datetime → 사용자 TZ 기준 달력 날짜."""
    return as_aware_utc(dt).astimezone(zone).date()
