"""DB 엔진 / 세션 (SQLAlchemy 2.x sync).

DATABASE_URL 하나로 SQLite(개발/테스트) ↔ PostgreSQL(운영) 을 전환한다.
in-memory SQLite 는 StaticPool 로 단일 연결을 공유해 테스트에서 테이블이 유지되게 한다.
"""
from __future__ import annotations

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import settings

_url = settings.database_url
_connect_args: dict = {}
_engine_kwargs: dict = {}

if _url.startswith("sqlite"):
    _connect_args["check_same_thread"] = False
    # in-memory (sqlite:// 또는 :memory:) 는 단일 공유 연결이 필요하다.
    if ":memory:" in _url or _url in ("sqlite://", "sqlite:///:memory:"):
        _engine_kwargs["poolclass"] = StaticPool

engine = create_engine(
    _url,
    connect_args=_connect_args,
    future=True,
    **_engine_kwargs,
)

# ── SQLite 외래키 강제 ──────────────────────────────────────────
# SQLite 는 외래키 제약 검사가 커넥션 단위로 기본 OFF 다. 켜지 않으면 스키마에 선언한
# ON DELETE CASCADE / FK 제약이 개발·테스트에서 전부 무시되어, 운영(PostgreSQL)에서만
# 터지는 고아 레코드·삭제 실패를 미리 잡을 수 없다. 커넥션마다 PRAGMA 를 걸어 맞춘다.
# PostgreSQL 커넥션에 이 PRAGMA 를 보내면 문법 오류이므로 SQLite 일 때만 등록한다.
if engine.dialect.name == "sqlite":

    @event.listens_for(engine, "connect")
    def _sqlite_enable_foreign_keys(dbapi_connection, connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session)


def get_db():
    """FastAPI 의존성: 요청 스코프 DB 세션."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
