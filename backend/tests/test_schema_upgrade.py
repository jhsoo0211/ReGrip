"""Existing SQLite data survives 004/005, including WAL commits and interrupted upgrades."""
import json
from pathlib import Path
from types import SimpleNamespace
import sqlite3

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.dialects import sqlite as sqlite_dialect
from sqlalchemy.schema import CreateTable

from scripts import upgrade_sqlite
from src.core import schema as core_schema
from src.core.schema import verify_session_schema
from src.models import Base

OLD_CHECK = "input_source IN ('ble','websocket','simulation','unknown')"
NEW_CHECK = "input_source IN ('ble','usb','websocket','simulation','unknown')"
# The 004-era upgrade_sqlite statement (column-level CHECK without usb).
OLD_ADD_INPUT_SOURCE = ("ALTER TABLE sessions ADD COLUMN input_source VARCHAR(16) NOT NULL "
                        "DEFAULT 'unknown' CHECK (" + OLD_CHECK + ")")


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
        db.execute("UPDATE sessions SET input_source='usb'")
        db.rollback()
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


def make_old_004(path, *, wal=False):
    """A DB upgraded by the 004-era script: column-level CHECK without usb."""
    db = make_legacy(path, wal=wal)
    db.execute(OLD_ADD_INPUT_SOURCE)
    db.execute("ALTER TABLE sessions ADD COLUMN calibration_snapshot JSON")
    db.execute("UPDATE sessions SET input_source='ble', calibration_snapshot=?",
               (json.dumps({"version": 2, "source": "ble"}),))
    db.commit()
    return db


def make_old_create_all(path):
    """A DB created by 004-era create_all: table-level ck_sessions_input_source without usb."""
    ddl = str(CreateTable(Base.metadata.tables["sessions"]).compile(dialect=sqlite_dialect.dialect()))
    assert "CONSTRAINT ck_sessions_input_source CHECK (" + NEW_CHECK + ")" in ddl
    db = sqlite3.connect(path)
    db.execute(ddl.replace(NEW_CHECK, OLD_CHECK))
    db.execute("CREATE TABLE xp_events (amount INTEGER)")
    db.execute("INSERT INTO sessions (id, client_session_id, user_id, exercise_type, started_at, "
               "duration_sec, set_count, avg_force, max_force, stars, attempts, input_source, "
               "result_snapshot) VALUES ('s1','c1','u1','game_balloon','2026-01-01 00:00:00',"
               "60,1,30,50,2,0,'ble',?)", (json.dumps({"xpAwarded": 123, "session": {"id": "s1"}}),))
    db.execute("INSERT INTO xp_events VALUES (123)")
    db.commit()
    return db


def _table_sql(path):
    with sqlite3.connect(path) as db:
        return db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").fetchone()[0]


@pytest.mark.parametrize("make", [make_old_004, make_old_create_all])
def test_stale_input_source_check_is_widened_in_place(tmp_path, make):
    path = tmp_path / "stale.db"
    make(path).close()
    before_sql = _table_sql(path)
    assert before_sql.count(OLD_CHECK) == 1
    result = upgrade_sqlite.upgrade_database(path)
    assert result["changed"] is True
    assert result["widenedInputSourceCheck"] is True
    assert result["addedColumns"] == []
    assert _table_sql(path) == before_sql.replace(OLD_CHECK, NEW_CHECK)
    with sqlite3.connect(result["backup"]) as backup:
        assert OLD_CHECK in backup.execute("SELECT sql FROM sqlite_master WHERE name='sessions'").fetchone()[0]
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("SELECT id, input_source FROM sessions").fetchall() == [("s1", "ble")]
        assert json.loads(db.execute("SELECT result_snapshot FROM sessions").fetchone()[0])["xpAwarded"] == 123
        assert db.execute("SELECT amount FROM xp_events").fetchone()[0] == 123
        db.execute("UPDATE sessions SET input_source='usb'")
        db.commit()
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE sessions SET input_source='guessed'")
    second = upgrade_sqlite.upgrade_database(path)
    assert second["changed"] is False
    assert second["staleInputSourceCheck"] is False
    assert len(list((tmp_path / ".backups").iterdir())) == 1


def test_create_all_widening_keeps_other_constraints(tmp_path):
    path = tmp_path / "create_all.db"
    make_old_create_all(path).close()
    upgrade_sqlite.upgrade_database(path)
    with sqlite3.connect(path) as db:
        db.execute("INSERT INTO sessions (id, client_session_id, user_id, exercise_type, started_at, "
                   "duration_sec, set_count, avg_force, max_force, stars, attempts, input_source) "
                   "VALUES ('s2','c2','u1','game_balloon','2026-01-02 00:00:00',60,1,30,50,2,0,'usb')")
        for statement in ("UPDATE sessions SET stars=5", "UPDATE sessions SET exercise_type='guessed'",
                          "INSERT INTO sessions (id, client_session_id, user_id, exercise_type, started_at, "
                          "duration_sec, set_count, avg_force, max_force, stars, attempts) VALUES "
                          "('s3','c1','u1','game_balloon','2026-01-03',60,1,30,50,2,0)"):
            with pytest.raises(sqlite3.IntegrityError):
                db.execute(statement)


def test_missing_column_and_stale_check_upgrade_together(tmp_path):
    path = tmp_path / "half.db"
    db = make_legacy(path)
    db.execute(OLD_ADD_INPUT_SOURCE)
    db.commit()
    db.close()
    result = upgrade_sqlite.upgrade_database(path)
    assert result["addedColumns"] == ["calibration_snapshot"]
    assert result["widenedInputSourceCheck"] is True
    assert NEW_CHECK in _table_sql(path) and OLD_CHECK not in _table_sql(path)


def test_wal_database_widening(tmp_path):
    path = tmp_path / "wal_stale.db"
    connection = make_old_004(path, wal=True)
    try:
        result = upgrade_sqlite.upgrade_database(path)
        assert result["widenedInputSourceCheck"] is True
    finally:
        connection.close()
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        db.execute("UPDATE sessions SET input_source='usb'")


def test_dry_run_reports_stale_check_without_changes(tmp_path):
    path = tmp_path / "dry.db"
    make_old_004(path).close()
    before = path.read_bytes()
    dry = upgrade_sqlite.upgrade_database(path, dry_run=True)
    assert dry["changed"] is False
    assert dry["dryRun"] is True
    assert dry["missingColumns"] == []
    assert dry["staleInputSourceCheck"] is True
    assert dry["backup"] is None
    assert path.read_bytes() == before
    assert not (tmp_path / ".backups").exists()


def test_unrecognized_input_source_check_is_refused(tmp_path):
    path = tmp_path / "odd.db"
    db = make_legacy(path)
    db.execute("ALTER TABLE sessions ADD COLUMN input_source VARCHAR(16) NOT NULL DEFAULT 'unknown' "
               "CHECK (input_source IN ('ble','websocket','unknown'))")
    db.execute("ALTER TABLE sessions ADD COLUMN calibration_snapshot JSON")
    db.commit()
    db.close()
    before = path.read_bytes()
    for dry_run in (True, False):
        with pytest.raises(ValueError, match="input_source"):
            upgrade_sqlite.upgrade_database(path, dry_run=dry_run)
    assert path.read_bytes() == before
    assert not (tmp_path / ".backups").exists()


def test_widen_failure_rolls_back_and_names_backup(tmp_path, monkeypatch):
    path = tmp_path / "widen_fail.db"
    make_old_004(path).close()
    before_sql = _table_sql(path)
    monkeypatch.setattr(upgrade_sqlite, "_INPUT_SOURCE_CHECK", "input_source IN (")
    with pytest.raises(RuntimeError, match="백업"):
        upgrade_sqlite.upgrade_database(path)
    assert _table_sql(path) == before_sql
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert len(list((tmp_path / ".backups").iterdir())) == 1


@pytest.mark.parametrize("make", [make_old_004, make_old_create_all])
def test_stale_check_guard_then_upgrade(tmp_path, make):
    path = tmp_path / "guard.db"
    make(path).close()
    engine = create_engine("sqlite:///" + str(path))
    try:
        with pytest.raises(RuntimeError, match="scripts.upgrade_sqlite"):
            verify_session_schema(engine)
        engine.dispose()
        upgrade_sqlite.upgrade_database(path)
        verify_session_schema(engine)
    finally:
        engine.dispose()


def _fake_postgres(monkeypatch, sqltext):
    inspector = SimpleNamespace(
        has_table=lambda name: True,
        get_columns=lambda name: [{"name": n} for n in ("id", "input_source", "calibration_snapshot")],
        get_check_constraints=lambda name: [{"name": "ck_sessions_input_source", "sqltext": sqltext}],
    )
    monkeypatch.setattr(core_schema, "inspect", lambda engine: inspector)
    return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))


def test_postgres_stale_check_guard(monkeypatch):
    old = ("((input_source)::text = ANY ((ARRAY['ble'::character varying, 'websocket'::character varying, "
           "'simulation'::character varying, 'unknown'::character varying])::text[]))")
    with pytest.raises(RuntimeError, match="005_usb_input_source.sql"):
        verify_session_schema(_fake_postgres(monkeypatch, old))
    new = old.replace("'ble'::character varying, ", "'ble'::character varying, 'usb'::character varying, ")
    verify_session_schema(_fake_postgres(monkeypatch, new))
