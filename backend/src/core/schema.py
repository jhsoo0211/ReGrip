"""Fail before serving with an existing database that create_all cannot upgrade."""
from sqlalchemy import inspect


def verify_session_schema(engine) -> None:
    inspector = inspect(engine)
    if not inspector.has_table("sessions"):
        return  # A fresh SQLite database is initialized by create_all immediately afterwards.
    columns = {column["name"] for column in inspector.get_columns("sessions")}
    missing = {"input_source", "calibration_snapshot"} - columns
    if not missing:
        return
    if engine.dialect.name == "sqlite":
        remedy = (
            "API를 중지하고 backend에서 "
            "python -m scripts.upgrade_sqlite --database <기존 DB 경로> 를 실행하세요. "
            "업그레이드는 원본을 먼저 백업하며 기존 기록을 보존합니다. DB를 삭제하지 마세요."
        )
    else:
        remedy = "migrations/004_session_provenance.sql을 적용한 뒤 다시 시작하세요."
    raise RuntimeError("세션 DB 스키마 업그레이드가 필요합니다 (누락: "
                       + ", ".join(sorted(missing)) + "). " + remedy)
