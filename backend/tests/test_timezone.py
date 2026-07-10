"""회귀: 사용자 TZ 달력일 산출(A4) + settings.timezone 검증/노출."""
from __future__ import annotations

from datetime import datetime

from src.core.timeutil import resolve_zone, to_user_date
from tests.conftest import register_and_auth


def test_session_date_uses_user_timezone_kst_boundary():
    """startedAt 2026-07-09T16:00:00Z(=KST 07-10 01:00) 의 session_date 는 07-10 이어야 한다."""
    zone = resolve_zone("Asia/Seoul")
    # 저장 형식(naive UTC) 로 계산 — UTC 로는 07-09 지만 KST 로는 07-10.
    dt = datetime(2026, 7, 9, 16, 0, 0)
    assert to_user_date(dt, zone).isoformat() == "2026-07-10"
    # KST 로 아직 07-09 인 인접 시각(UTC 14:59 = KST 23:59 07-09)
    dt_prev = datetime(2026, 7, 9, 14, 59, 0)
    assert to_user_date(dt_prev, zone).isoformat() == "2026-07-09"


def test_invalid_timezone_defaults_to_seoul():
    # 무효 tz 는 기본(Asia/Seoul) 로 폴백 → UTC 오프셋 +9 확인
    zone = resolve_zone("Not/AZone")
    dt = datetime(2026, 7, 9, 16, 0, 0)
    assert to_user_date(dt, zone).isoformat() == "2026-07-10"


def test_settings_timezone_update_and_validation(client):
    _, headers = register_and_auth(client)

    # 기본값 노출
    r = client.get("/api/v1/users/me/settings", headers=headers)
    assert r.status_code == 200
    assert r.json()["timezone"] == "Asia/Seoul"

    # 유효한 IANA 로 변경
    r = client.put(
        "/api/v1/users/me/settings", headers=headers, json={"timezone": "America/New_York"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["timezone"] == "America/New_York"

    # 잘못된 값 → 422
    r = client.put(
        "/api/v1/users/me/settings", headers=headers, json={"timezone": "Mars/Phobos"}
    )
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == "VALIDATION_FAILED"
    assert r.json()["error"]["details"]["field"] == "timezone"
