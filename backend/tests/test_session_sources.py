"""Input provenance, isolated measurement statistics, and backward-compatible replay."""
from datetime import datetime, timedelta, timezone
import uuid

import pytest

from src.core.db import SessionLocal
from src.models import Session as SessionModel
from tests.conftest import register_and_auth


def payload(source="unknown", **overrides):
    result = {
        "clientSessionId": str(uuid.uuid4()),
        "exerciseType": "game_balloon",
        "startedAt": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
        "durationSec": 120,
        "score": 5,
        "avgForce": 30,
        "maxForce": 50,
        "inputSource": source,
    }
    if source == "ble":
        result["calibrationSnapshot"] = {
            "version": 2, "source": "ble", "unit": "adc_12bit", "channel": "fsr",
            "baseline0": 3000, "baseline100": 1000,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
        }
    result.update(overrides)
    return result


def test_ble_snapshot_roundtrip_and_idempotent_replay(client):
    _, headers = register_and_auth(client)
    body = payload("ble")
    first = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert first.status_code == 201, first.text
    stored = first.json()["session"]
    assert stored["inputSource"] == "ble"
    assert stored["calibrationSnapshot"]["baseline0"] == 3000
    assert stored["calibrationSnapshot"]["baseline100"] == 1000
    body["calibrationSnapshot"]["baseline0"] = 3100
    repeat = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert repeat.status_code == 200
    assert repeat.json() == first.json()
    detail = client.get("/api/v1/users/me/sessions/" + stored["id"], headers=headers).json()
    listed = client.get("/api/v1/users/me/sessions?source=real", headers=headers).json()["data"]
    assert detail["calibrationSnapshot"] == stored["calibrationSnapshot"]
    assert listed[0]["inputSource"] == "ble"


@pytest.mark.parametrize("overrides", [
    {"inputSource": "ble", "calibrationSnapshot": None},
    {"inputSource": "other"},
    {"inputSource": "simulation"},
    {"calibrationSnapshot": {"version": 1}},
])
def test_invalid_session_provenance_422(client, overrides):
    _, headers = register_and_auth(client)
    body = payload("ble", **overrides)
    response = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("baseline0,baseline100,expected", [
    (0, 64, 201), (4095, 4031, 201), (1000, 1063, 422),
    (-1, 1000, 422), (0, 4096, 422), (1000, 1000, 422),
])
def test_ble_snapshot_adc_limits_and_polarity(client, baseline0, baseline100, expected):
    _, headers = register_and_auth(client)
    body = payload("ble")
    body["calibrationSnapshot"].update(baseline0=baseline0, baseline100=baseline100)
    response = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert response.status_code == expected, response.text


def test_source_filters_keep_global_rewards_and_separate_measurements(client):
    _, headers = register_and_auth(client)
    for source, force in [("ble", 30), ("websocket", 40), ("simulation", 100), ("unknown", 90)]:
        r = client.post("/api/v1/users/me/sessions", headers=headers,
                        json=payload(source, avgForce=force, maxForce=force))
        assert r.status_code == 201, r.text
    all_stats = client.get("/api/v1/users/me/stats?source=all", headers=headers).json()
    real = client.get("/api/v1/users/me/stats?source=real", headers=headers).json()
    sim = client.get("/api/v1/users/me/stats?source=simulation", headers=headers).json()
    assert real["source"] == "real"
    assert real["sourceCounts"] == {"real": 2, "simulation": 1, "unknown": 1}
    assert real["allSessionCount"] == all_stats["totalSessions"] == 4
    assert real["totalSessions"] == 2
    assert real["bestMaxForce"] == 40
    assert sim["bestMaxForce"] == 100
    assert sum(p["sessions"] for p in real["chart"]) == 2
    assert [p["avgForce"] for p in real["chart"] if p["sessions"]] == [35]
    for key in ("totalXp", "level", "tier", "currentStreak", "longestStreak"):
        assert real[key] == all_stats[key] == sim[key]
    for source, count in (("all", 4), ("real", 2), ("simulation", 1), ("unknown", 1)):
        r = client.get("/api/v1/users/me/sessions?source=" + source, headers=headers)
        assert len(r.json()["data"]) == count
    assert client.get("/api/v1/users/me/stats?source=ble", headers=headers).status_code == 422
    assert client.get("/api/v1/users/me/sessions?source=ble", headers=headers).status_code == 422


def test_legacy_snapshot_adds_unknown_without_recalculating_rewards(client):
    _, headers = register_and_auth(client)
    body = payload()
    body.pop("inputSource")
    response = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert response.status_code == 201
    first = response.json()
    with SessionLocal() as db:
        row = db.get(SessionModel, first["session"]["id"])
        old = dict(row.result_snapshot)
        old["session"] = {k: v for k, v in old["session"].items()
                          if k not in ("inputSource", "calibrationSnapshot")}
        old["xpAwarded"] = 123
        row.result_snapshot = old
        db.commit()
    replay = client.post("/api/v1/users/me/sessions", headers=headers, json=body).json()
    assert replay["session"]["inputSource"] == "unknown"
    assert replay["session"]["calibrationSnapshot"] is None
    assert replay["xpAwarded"] == 123


def test_real_stats_empty_for_only_legacy_and_simulation(client):
    _, headers = register_and_auth(client)
    for source in ("unknown", "simulation"):
        assert client.post("/api/v1/users/me/sessions", headers=headers,
                           json=payload(source)).status_code == 201
    stats = client.get("/api/v1/users/me/stats?source=real", headers=headers).json()
    assert stats["totalSessions"] == 0
    assert stats["bestMaxForce"] is None
    assert all(p["avgForce"] is None for p in stats["chart"])
    assert stats["allSessionCount"] == 2
