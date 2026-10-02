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
    elif source == "usb":
        result["calibrationSnapshot"] = finger_snapshot()
    result.update(overrides)
    return result


def finger_snapshot(source="usb", **overrides):
    result = {
        "version": 3, "source": source, "unit": "adc_12bit", "channel": "finger_flex",
        "fingers": [{"open": 1780, "closed": 2780, "use": True}, None, None,
                    {"open": 1825, "closed": 2825, "use": False}, None],
        "capturedAt": "2026-10-02T00:00:00Z",
    }
    result.update(overrides)
    return result


@pytest.mark.parametrize("channel", ["fsr", "finger_mean"])
def test_ble_snapshot_roundtrip_and_idempotent_replay(client, channel):
    _, headers = register_and_auth(client)
    body = payload("ble")
    body["calibrationSnapshot"]["channel"] = channel
    first = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert first.status_code == 201, first.text
    stored = first.json()["session"]
    assert stored["inputSource"] == "ble"
    assert stored["calibrationSnapshot"]["channel"] == channel
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


def test_usb_finger_snapshot_roundtrip_and_idempotent_replay(client):
    _, headers = register_and_auth(client)
    body = payload("usb")
    first = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert first.status_code == 201, first.text
    stored = first.json()["session"]
    assert stored["inputSource"] == "usb"
    snapshot = stored["calibrationSnapshot"]
    assert {k: snapshot[k] for k in ("version", "source", "unit", "channel")} == {
        "version": 3, "source": "usb", "unit": "adc_12bit", "channel": "finger_flex"}
    assert snapshot["fingers"] == finger_snapshot()["fingers"]
    assert snapshot["fingers"][3]["use"] is False
    assert datetime.fromisoformat(snapshot["capturedAt"]) == datetime(2026, 10, 2, tzinfo=timezone.utc)
    body["calibrationSnapshot"]["fingers"][0]["open"] = 1700
    repeat = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert repeat.status_code == 200
    assert repeat.json() == first.json()
    detail = client.get("/api/v1/users/me/sessions/" + stored["id"], headers=headers).json()
    listed = client.get("/api/v1/users/me/sessions?source=real", headers=headers).json()["data"]
    assert detail["inputSource"] == "usb"
    assert detail["calibrationSnapshot"] == snapshot
    assert listed[0]["calibrationSnapshot"] == snapshot


def test_ble_accepts_finger_snapshot(client):
    _, headers = register_and_auth(client)
    body = payload("ble", calibrationSnapshot=finger_snapshot("ble"))
    response = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert response.status_code == 201, response.text
    assert response.json()["session"]["calibrationSnapshot"]["version"] == 3
    assert response.json()["session"]["calibrationSnapshot"]["source"] == "ble"


def _finger(open_=1000, closed=2000, use=True):
    return {"open": open_, "closed": closed, "use": use}


@pytest.mark.parametrize("fingers,expected", [
    ([_finger(0, 64), None, None, None, None], 201),
    ([_finger(4095, 4031), None, None, None, None], 201),
    ([_finger(2000, 1000), _finger(use=False), _finger(), _finger(), _finger()], 201),
    ([_finger(), None, None, None], 422),
    ([_finger(), None, None, None, None, None], 422),
    ([_finger(1000, 1063), None, None, None, None], 422),
    ([_finger(1000, 937), None, None, None, None], 422),
    ([_finger(4096, 2000), None, None, None, None], 422),
    ([_finger(-1, 2000), None, None, None, None], 422),
    ([_finger(1000, 4096), None, None, None, None], 422),
    ([_finger(use="yes"), None, None, None, None], 422),
    ([_finger(use=1), None, None, None, None], 422),
    ([{"open": 1000, "closed": 2000}, None, None, None, None], 422),
    ([_finger(use=False), _finger(use=False), None, None, None], 422),
    ([None, None, None, None, None], 422),
    ([_finger(), None, None, None, 7], 422),
])
def test_usb_finger_snapshot_limits(client, fingers, expected):
    _, headers = register_and_auth(client)
    body = payload("usb", calibrationSnapshot=finger_snapshot(fingers=fingers))
    response = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert response.status_code == expected, response.text


@pytest.mark.parametrize("source,snapshot", [
    ("usb", "v2"),
    ("usb", finger_snapshot("ble")),
    ("ble", finger_snapshot("usb")),
    ("usb", None),
    ("usb", "omit"),
    ("simulation", finger_snapshot()),
    ("websocket", finger_snapshot()),
    ("unknown", finger_snapshot("ble")),
    ("usb", finger_snapshot(channel="finger_mean")),
    ("usb", finger_snapshot(unit="volts")),
    ("usb", finger_snapshot(source="websocket")),
    ("usb", finger_snapshot(capturedAt="2026-10-02T00:00:00")),
    ("usb", finger_snapshot(fingers=None)),
    ("ble", "v2_finger_flex"),
    ("usb", {**finger_snapshot(), "version": 2}),
])
def test_invalid_usb_provenance_422(client, source, snapshot):
    _, headers = register_and_auth(client)
    body = payload(source)
    if snapshot == "v2":
        body["calibrationSnapshot"] = payload("ble")["calibrationSnapshot"]
    elif snapshot == "v2_finger_flex":
        body["calibrationSnapshot"] = {**payload("ble")["calibrationSnapshot"], "channel": "finger_flex"}
    elif snapshot == "omit":
        body.pop("calibrationSnapshot", None)
    else:
        body["calibrationSnapshot"] = snapshot
    response = client.post("/api/v1/users/me/sessions", headers=headers, json=body)
    assert response.status_code == 422, response.text


def test_source_filters_keep_global_rewards_and_separate_measurements(client):
    _, headers = register_and_auth(client)
    for source, force in [("ble", 30), ("usb", 50), ("websocket", 40), ("simulation", 100), ("unknown", 90)]:
        r = client.post("/api/v1/users/me/sessions", headers=headers,
                        json=payload(source, avgForce=force, maxForce=force))
        assert r.status_code == 201, r.text
    all_stats = client.get("/api/v1/users/me/stats?source=all", headers=headers).json()
    real = client.get("/api/v1/users/me/stats?source=real", headers=headers).json()
    sim = client.get("/api/v1/users/me/stats?source=simulation", headers=headers).json()
    assert real["source"] == "real"
    assert real["sourceCounts"] == {"real": 3, "simulation": 1, "unknown": 1}
    assert real["allSessionCount"] == all_stats["totalSessions"] == 5
    assert real["totalSessions"] == 3
    assert real["bestMaxForce"] == 50
    assert sim["bestMaxForce"] == 100
    assert sum(p["sessions"] for p in real["chart"]) == 3
    assert [p["avgForce"] for p in real["chart"] if p["sessions"]] == [40]
    for key in ("totalXp", "level", "tier", "currentStreak", "longestStreak"):
        assert real[key] == all_stats[key] == sim[key]
    for source, count in (("all", 5), ("real", 3), ("simulation", 1), ("unknown", 1)):
        r = client.get("/api/v1/users/me/sessions?source=" + source, headers=headers)
        assert len(r.json()["data"]) == count
    real_sources = client.get("/api/v1/users/me/sessions?source=real", headers=headers).json()["data"]
    assert sorted(s["inputSource"] for s in real_sources) == ["ble", "usb", "websocket"]
    for source in ("ble", "usb"):
        assert client.get("/api/v1/users/me/stats?source=" + source, headers=headers).status_code == 422
        assert client.get("/api/v1/users/me/sessions?source=" + source, headers=headers).status_code == 422


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
