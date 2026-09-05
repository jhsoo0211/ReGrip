"""Client mistakes are 422; private storage and local calendar boundaries are preserved."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import uuid

import pytest

from src.core.db import SessionLocal
from src.models import Device
from tests.conftest import register_and_auth
from tests.test_session_sources import payload


@pytest.mark.parametrize("body", [
    {"difficulty": "unknown"}, {"hand": "unknown"},
    {"reminderTime": "25:70"}, {"reminderTime": "9:00"},
    {"reminderTime": "09:00:50"}, {"reminderTime": ""},
])
def test_invalid_settings_422(client, body):
    _, headers = register_and_auth(client)
    r = client.put("/api/v1/users/me/settings", headers=headers, json=body)
    assert r.status_code == 422, r.text


def test_normal_difficulty_compatibility(client):
    _, headers = register_and_auth(client)
    r = client.put("/api/v1/users/me/settings", headers=headers, json={"difficulty": "normal"})
    assert r.status_code == 200
    assert r.json()["difficulty"] == "medium"
    r = client.post("/api/v1/users/me/sessions", headers=headers,
                    json=payload(difficulty="normal"))
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("overrides", [
    {"forceSeries": [-1]}, {"forceSeries": [101]}, {"difficulty": "other"},
    {"handUsed": "other"}, {"sets": [{"setIndex": 1, "avgForce": 70, "peakForce": 50}]},
    {"clientSessionId": "invalid-uuid"}, {"deviceId": "invalid-uuid"},
    {"durationSec": 2147483648},
    {"startedAt": "0001-01-01T00:00:00+09:00"},
    {"startedAt": "9999-12-31T23:59:59-09:00"},
])
def test_invalid_session_measurements_422(client, overrides):
    _, headers = register_and_auth(client)
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload(**overrides))
    assert r.status_code == 422, r.text


@pytest.mark.parametrize("field", ["forceSeries", "avgForce", "maxForce"])
def test_nonfinite_session_values_422(client, field):
    import json
    _, headers = register_and_auth(client)
    body = payload(**{field: [float("nan")] if field == "forceSeries" else float("inf")})
    r = client.post("/api/v1/users/me/sessions", headers={**headers, "Content-Type": "application/json"},
                    content=json.dumps(body))
    assert r.status_code == 422, r.text


def test_calibration_finite_range_and_owned_device(client):
    _, headers = register_and_auth(client)
    _, other_headers = register_and_auth(client, email="other@example.com")
    from src.core.security import decode_access_token
    other_id = decode_access_token(other_headers["Authorization"].split()[1])["sub"]
    device_id = str(uuid.uuid4())
    with SessionLocal() as db:
        db.add(Device(id=device_id, serial_no="fixture-device", owner_user_id=other_id))
        db.commit()
    for body in (
        {"baselineRaw0": 100, "baselineRaw100": 100},
        {"baselineRaw0": 100, "baselineRaw100": 500, "deviceId": str(uuid.uuid4())},
        {"baselineRaw0": 100, "baselineRaw100": 500, "deviceId": device_id},
        {"baselineRaw0": 100, "baselineRaw100": 500, "deviceId": "invalid-uuid"},
    ):
        assert client.post("/api/v1/users/me/calibrations", headers=headers, json=body).status_code == 422
    r = client.post("/api/v1/users/me/calibrations", headers=headers,
                    json={"baselineRaw0": 900, "baselineRaw100": 500})
    assert r.status_code == 201  # polarity is a sensor property
    r = client.post("/api/v1/users/me/calibrations", headers={**headers, "Content-Type": "application/json"},
                    content='{"baselineRaw0":0,"baselineRaw100":Infinity}')
    assert r.status_code == 422
    r = client.post("/api/v1/users/me/sessions", headers=headers, json=payload(deviceId=device_id))
    assert r.status_code == 422


def test_sessions_date_filter_uses_same_user_day_as_stats(client):
    _, headers = register_and_auth(client)
    local = datetime.now(ZoneInfo("Asia/Seoul")).replace(hour=0, minute=0, second=0, microsecond=0)
    r = client.post("/api/v1/users/me/sessions", headers=headers,
                    json=payload(startedAt=local.astimezone(timezone.utc).isoformat()))
    assert r.status_code == 201, r.text
    day = local.date().isoformat()
    listed = client.get(f"/api/v1/users/me/sessions?from={day}&to={day}", headers=headers)
    chart = client.get("/api/v1/users/me/stats?range=1d", headers=headers)
    assert len(listed.json()["data"]) == chart.json()["chart"][0]["sessions"] == 1


def test_private_storage_is_not_public(client, tmp_path):
    from src.main import app
    from starlette.staticfiles import StaticFiles
    mounts = [r for r in app.routes if isinstance(getattr(r, "app", None), StaticFiles)]
    assert [m.path for m in mounts] == ["/static/avatars"]
    for path in ("/static/sig_ingest.db", "/static/train_preds.npz", "/static/train_results.json"):
        assert client.head(path).status_code == 404


@pytest.mark.parametrize("path", [
    "/api/v1/users/me/sessions/not-a-uuid",
    "/api/v1/users/me/sessions?to=9999-12-31",
    "/api/v1/users/me/sessions?from=0001-01-01",
])
def test_session_lookup_boundaries_are_422(client, path):
    _, headers = register_and_auth(client)
    response = client.get(path, headers=headers)
    assert response.status_code == 422, response.text


def test_session_cursor_rejects_non_uuid_id(client):
    import base64
    import json
    _, headers = register_and_auth(client)
    cursor = base64.urlsafe_b64encode(json.dumps({"s": "2026-09-01T00:00:00", "id": "not-a-uuid"}).encode()).decode()
    response = client.get("/api/v1/users/me/sessions", headers=headers, params={"cursor": cursor})
    assert response.status_code == 400
    assert response.json()["error"]["details"]["field"] == "cursor"
