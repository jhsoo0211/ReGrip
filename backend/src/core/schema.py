"""Fail before serving with an existing database that create_all cannot upgrade."""
import re

from sqlalchemy import inspect

# 004-era input_source CHECK (without usb), as written by create_all or upgrade_sqlite.
_OLD_INPUT_SOURCE_CHECK = re.compile(
    r"\binput_source\s+(?i:IN)\s*\(\s*'ble'\s*,\s*'websocket'\s*,\s*'simulation'\s*,\s*'unknown'\s*\)")


def _input_source_check_stale(engine, inspector) -> bool:
    """True when the stored input_source CHECK still rejects 'usb' (migration 005 missing)."""
    if engine.dialect.name == "sqlite":
        with engine.connect() as connection:
            sql = connection.exec_driver_sql(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").scalar()
        return bool(sql and _OLD_INPUT_SOURCE_CHECK.search(sql))
    for check in inspector.get_check_constraints("sessions"):
        if check.get("name") == "ck_sessions_input_source":
            return "'usb'" not in (check.get("sqltext") or "")
    return False


def verify_session_schema(engine) -> None:
    inspector = inspect(engine)
    if not inspector.has_table("sessions"):
        return  # A fresh SQLite database is initialized by create_all immediately afterwards.
    columns = {column["name"] for column in inspector.get_columns("sessions")}
    missing = {"input_source", "calibration_snapshot"} - columns
    stale = "input_source" in columns and _input_source_check_stale(engine, inspector)
    if not missing and not stale:
        return
    if engine.dialect.name == "sqlite":
        remedy = (
            "API를 중지하고 backend에서 "
            "python -m scripts.upgrade_sqlite --database <기존 DB 경로> 를 실행하세요. "
            "업그레이드는 원본을 먼저 백업하며 기존 기록을 보존합니다. DB를 삭제하지 마세요."
        )
    elif missing:
        remedy = ("migrations/004_session_provenance.sql과 005_usb_input_source.sql을 "
                  "순서대로 적용한 뒤 다시 시작하세요.")
    else:
        remedy = "migrations/005_usb_input_source.sql을 적용한 뒤 다시 시작하세요."
    problems = []
    if missing:
        problems.append("누락: " + ", ".join(sorted(missing)))
    if stale:
        problems.append("input_source CHECK에 usb 없음")
    raise RuntimeError("세션 DB 스키마 업그레이드가 필요합니다 (" + "; ".join(problems) + "). " + remedy)
