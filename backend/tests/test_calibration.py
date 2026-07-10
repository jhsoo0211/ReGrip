"""케이스 7: 캘리브레이션 POST → latest 반환."""
from __future__ import annotations

from tests.conftest import register_and_auth


def test_calibration_post_then_latest(client):
    _, headers = register_and_auth(client)

    # latest 없음 → 404
    r = client.get("/api/v1/users/me/calibrations/latest", headers=headers)
    assert r.status_code == 404

    # 첫 캘리브레이션
    r = client.post(
        "/api/v1/users/me/calibrations",
        headers=headers,
        json={"baselineRaw0": 512.0, "baselineRaw100": 890.0},
    )
    assert r.status_code == 201, r.text
    assert r.json()["baselineRaw0"] == 512.0
    assert r.json()["baselineRaw100"] == 890.0

    # 두 번째(재보정) — 이력 누적, latest 는 최신
    r = client.post(
        "/api/v1/users/me/calibrations",
        headers=headers,
        json={"baselineRaw0": 500.0, "baselineRaw100": 900.0},
    )
    assert r.status_code == 201
    latest_id = r.json()["id"]

    r = client.get("/api/v1/users/me/calibrations/latest", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == latest_id
    assert body["baselineRaw0"] == 500.0
    assert body["baselineRaw100"] == 900.0
