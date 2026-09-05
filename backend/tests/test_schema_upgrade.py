"""Existing SQLite data survives 004, including WAL commits and interrupted upgrades."""
import json
from pathlib import Path
import sqlite3

import pytest
from sqlalchemy import create_engine, inspect

from scripts import upgrade_sqlite
from src.core.schema import verify_session_schema


def make_legacy(path, *, wal=False):
    connection = sqlite3.connect(path)
    if wal:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, "
                       "client_session_id TEXT, started_at TEXT, result_snapshot JSON)")
    connection.execute("CREATE TABLE xp_events (amount INTEGER)")
    connection.execute("INSERT INTO sessions VALUES ('s1','u1','c1','2026-01-01',?)",
                       (json.dumps({"xpAwarded": 123, "session": {"id": "s1"}}),))
    connection.execute("INSERT INTO xp_events VALUES (123)")
    connection.commit()
    return connection


def test_upgrade_preserves_records_and_idempotent_backup(tmp_path):
    path = tmp_path / "legacy.db"
    make_legacy(path).close()
    before = path.read_bytes()
    dry = upgrade_sqlite.upgrade_database(path, dry_run=True)
    assert dry["missingColumns"] == ["input_source", "calibration_snapshot"]
    assert path.read_bytes() == before
    assert not (tmp_path / ".backups").exists()

    result = upgrade_sqlite.upgrade_database(path)
    assert result["changed"]
    with sqlite3.connect(result["backup"]) as backup:
        assert len(backup.execute("PRAGMA table_info(sessions)").fetchall()) == 5
        assert backup.execute("SELECT amount FROM xp_events").fetchone()[0] == 123
    with sqlite3.connect(path) as db:
        row = db.execute("SELECT input_source,calibration_snapshot,result_snapshot FROM sessions").fetchone()
        assert row[:2] == ("unknown", None)
        assert json.loads(row[2])["xpAwarded"] == 123
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE sessions SET input_source='guessed'")
    assert upgrade_sqlite.upgrade_database(path)["changed"] is False
    assert len(list((tmp_path / ".backups").iterdir())) == 1


def test_backup_includes_committed_wal_pages(tmp_path):
    path = tmp_path / "wal.db"
    connection = make_legacy(path, wal=True)
    try:
        assert Path(str(path) + "-wal").stat().st_size > 0
        result = upgrade_sqlite.upgrade_database(path)
        with sqlite3.connect(result["backup"]) as backup:
            assert backup.execute("SELECT id FROM sessions").fetchone()[0] == "s1"
    finally:
        connection.close()


def test_upgrade_rollback_does_not_leave_half_migrated_schema(tmp_path, monkeypatch):
    path = tmp_path / "failure.db"
    make_legacy(path).close()
    monkeypatch.setattr(upgrade_sqlite, "_ADD_COLUMNS", {
        "input_source": upgrade_sqlite._ADD_COLUMNS["input_source"],
        "calibration_snapshot": "THIS IS INVALID SQL",
    })
    with pytest.raises(RuntimeError, match="백업"):
        upgrade_sqlite.upgrade_database(path)
    with sqlite3.connect(path) as db:
        assert len(db.execute("PRAGMA table_info(sessions)").fetchall()) == 5
        assert db.execute("SELECT amount FROM xp_events").fetchone()[0] == 123


def test_old_schema_guard_then_upgrade(tmp_path):
    path = tmp_path / "old.db"
    make_legacy(path).close()
    engine = create_engine("sqlite:///" + str(path))
    try:
        with pytest.raises(RuntimeError, match="scripts.upgrade_sqlite"):
            verify_session_schema(engine)
        upgrade_sqlite.upgrade_database(path)
        verify_session_schema(engine)
    finally:
        engine.dispose()


def test_fresh_schema_guard_does_not_create_tables(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "new.db"))
    try:
        verify_session_schema(engine)
        assert inspect(engine).get_table_names() == []
    finally:
        engine.dispose()


def test_partial_upgrade_preserves_known_source(tmp_path):
    path = tmp_path / "partial.db"
    db = make_legacy(path)
    db.execute(upgrade_sqlite._ADD_COLUMNS["input_source"])
    db.execute("UPDATE sessions SET input_source='simulation'")
    db.commit()
    db.close()
    result = upgrade_sqlite.upgrade_database(path)
    assert result["addedColumns"] == ["calibration_snapshot"]
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT input_source FROM sessions").fetchone()[0] == "simulation"


def test_002_drops_old_checks_before_normal_conversion():
    # Static ordering regression, not a claim that PostgreSQL migrations were executed.
    sql = (Path(__file__).parents[1] / "migrations" / "002_game_types.sql").read_text(encoding="utf-8")
    for table, named in (("sessions", "ck_sessions_difficulty"), ("user_settings", "ck_settings_difficulty")):
        update = sql.index(f"UPDATE {table} SET difficulty = 'medium'")
        assert sql.index(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {table}_difficulty_check") < update
        assert sql.index(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {named}") < update
        assert update < sql.index(f"ALTER TABLE {table} ADD CONSTRAINT {named}")
