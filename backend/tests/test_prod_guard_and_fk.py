"""운영 fail-fast 가드 + SQLite 외래키 강제 회귀 테스트.

이 파일이 지키는 것은 두 가지다.

1) `src.main._verify_prod_settings()` — ENV=prod 기동 전 필수 설정 검사.
   누가 이 함수를 지우거나 `if problems:` 를 없애면 .env 를 빠뜨린 운영 배포가 조용히
   성공한다(공개된 기본 시크릿으로 토큰 위조 가능, 개발용 SQLite 가 운영 DB 로 사용됨).
   `settings` 는 모듈 임포트 시점에 확정되는 전역이므로, 함수 시그니처를 건드리지 않고
   `monkeypatch.setattr(src.main, "settings", ...)` 로 갈아끼워 검사한다
   (monkeypatch 픽스처가 테스트 종료 시 자동 원복 → 다른 테스트 오염 없음).

2) `src.core.db` 의 `PRAGMA foreign_keys=ON` connect 리스너.
   SQLite 는 외래키 검사가 커넥션 단위로 기본 OFF 라, 리스너가 사라지면
   ON DELETE CASCADE 와 FK 제약이 개발·테스트에서 전부 무시된다(고아 레코드가
   운영 PostgreSQL 에서만 터진다). PRAGMA 값 / 실제 CASCADE 삭제 / 실제 FK 거부를
   각각 확인해 회귀를 잡는다.
"""
from __future__ import annotations

import base64
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from src import main as main_module
from src.core.config import Settings
from src.core.db import SessionLocal, engine
from tests.conftest import register_and_auth

_BACKEND = Path(__file__).resolve().parents[1]

# main.py 가 개발용 기본값으로 간주하는 값 (config.py 의 jwt_secret 기본값과 동일해야 한다)
DEV_JWT_SECRET = "dev-insecure-change-me"

_VALID_SECRET = "P" * 48  # 기본값 아님 + 32자 이상
_VALID_PHONE_KEY = base64.urlsafe_b64encode(b"\x11" * 32).decode()
_VALID_PG_URL = "postgresql+psycopg://regrip:pw@db.internal:5432/regrip"


def _prod_settings(**overrides) -> Settings:
    """검증을 통과하는 '정상 운영 설정'을 만들고, overrides 로 한 항목씩 망가뜨린다.

    Settings 는 BaseSettings 라 .env/환경변수를 읽지만, init 키워드가 최우선이므로
    아래 네 항목은 테스트가 완전히 통제한다.
    """
    kwargs = {
        "env": "prod",
        "jwt_secret": _VALID_SECRET,
        "phone_enc_key": _VALID_PHONE_KEY,
        "database_url": _VALID_PG_URL,
    }
    kwargs.update(overrides)
    return Settings(**kwargs)


def _verify_with(monkeypatch, **overrides) -> None:
    """전역 settings 를 갈아끼운 뒤 _verify_prod_settings() 를 호출한다."""
    monkeypatch.setattr(main_module, "settings", _prod_settings(**overrides))
    main_module._verify_prod_settings()


# ── 1. _verify_prod_settings() ─────────────────────────────────────────────
@pytest.mark.parametrize("env_value", ["dev", "test", "staging", "DEV"])
def test_non_prod_env_never_raises_even_with_dev_defaults(monkeypatch, env_value):
    """prod 가 아니면 위반이 몇 개든 통과해야 한다(로컬 개발이 막히면 안 된다)."""
    _verify_with(
        monkeypatch,
        env=env_value,
        jwt_secret=DEV_JWT_SECRET,
        phone_enc_key="",
        database_url="sqlite:///./regrip_dev.db",
    )


def test_prod_rejects_default_dev_jwt_secret(monkeypatch):
    with pytest.raises(RuntimeError) as exc:
        _verify_with(monkeypatch, jwt_secret=DEV_JWT_SECRET)
    msg = str(exc.value)
    assert "JWT_SECRET" in msg
    assert DEV_JWT_SECRET in msg  # 무엇이 문제인지 값까지 알려준다


def test_prod_rejects_short_jwt_secret(monkeypatch):
    with pytest.raises(RuntimeError) as exc:
        _verify_with(monkeypatch, jwt_secret="s" * 31)  # 32자 미만
    msg = str(exc.value)
    assert "JWT_SECRET" in msg
    assert "31" in msg  # 실제 길이를 보고한다


def test_prod_accepts_exactly_min_length_jwt_secret(monkeypatch):
    """경계값: 정확히 32자는 통과해야 한다(off-by-one 방지)."""
    _verify_with(monkeypatch, jwt_secret="s" * 32)


def test_prod_rejects_blank_phone_enc_key(monkeypatch):
    with pytest.raises(RuntimeError) as exc:
        _verify_with(monkeypatch, phone_enc_key="")
    assert "PHONE_ENC_KEY" in str(exc.value)


def test_prod_rejects_sqlite_database_url(monkeypatch):
    with pytest.raises(RuntimeError) as exc:
        _verify_with(monkeypatch, database_url="sqlite:///./regrip_dev.db")
    msg = str(exc.value)
    assert "DATABASE_URL" in msg
    assert "sqlite:///./regrip_dev.db" in msg


def test_prod_env_check_is_case_insensitive(monkeypatch):
    """ENV=PROD 도 운영이다(is_prod 가 lower() 비교) — 대문자로 가드를 우회할 수 없다."""
    with pytest.raises(RuntimeError):
        _verify_with(monkeypatch, env="PROD", jwt_secret=DEV_JWT_SECRET)


def test_prod_reports_all_violations_at_once(monkeypatch):
    """구현의 핵심 의도: 위반을 전부 모아 한 번에 보고한다(고치고-재기동 왕복 제거).

    첫 위반에서 즉시 raise 하는 구현으로 되돌아가면 이 테스트가 red 가 된다.
    """
    with pytest.raises(RuntimeError) as exc:
        _verify_with(
            monkeypatch,
            jwt_secret=DEV_JWT_SECRET,
            phone_enc_key="",
            database_url="sqlite:///./regrip_dev.db",
        )
    msg = str(exc.value)
    assert "JWT_SECRET" in msg
    assert "PHONE_ENC_KEY" in msg
    assert "DATABASE_URL" in msg
    # 헤더가 건수를 보고한다("아래 3건을 ..."). 단위 '건'까지 붙여야 의미가 있다 —
    # 그냥 "3" 은 JWT 최소길이 32 가 메시지에 들어가므로 무엇을 검증하든 항상 참인 죽은 단언이다.
    assert "3건" in msg, msg
    # 번호 매겨 나열: 정확히 1./2./3. 세 항목. 하나라도 빠지거나 늘면 red.
    assert re.findall(r"^ *(\d+)\. ", msg, flags=re.MULTILINE) == ["1", "2", "3"], msg


def test_prod_passes_when_all_settings_are_valid(monkeypatch):
    _verify_with(monkeypatch)  # 예외가 나면 실패


def test_verify_prod_settings_does_not_mutate_settings(monkeypatch):
    """가드는 검사만 한다 — 설정을 몰래 고쳐서 통과시키지 않는다."""
    fake = _prod_settings()
    monkeypatch.setattr(main_module, "settings", fake)
    before = (fake.env, fake.jwt_secret, fake.phone_enc_key, fake.database_url)
    main_module._verify_prod_settings()
    assert (fake.env, fake.jwt_secret, fake.phone_enc_key, fake.database_url) == before


# ── 1a. 가드가 실제 기동 경로에 연결돼 있는가 (wiring) ─────────────────────
# 위 테스트들은 _verify_prod_settings() 를 **직접 호출**하므로 함수 내부 로직만 지킨다.
# main.py 의 lifespan 에서 호출 한 줄(`_verify_prod_settings()`)이 사라져도 전부 green 이다
# — 즉 "가드가 있는데 아무도 부르지 않아 운영이 조용히 뜨는" 사고를 못 잡는다.
# 아래 두 테스트는 `with TestClient(app):` 로 실제 lifespan startup 을 태워 그 연결을 지킨다.
def test_lifespan_aborts_startup_when_prod_settings_are_invalid(monkeypatch):
    """운영 위반 설정으로 앱을 기동하면 lifespan 이 RuntimeError 로 기동을 중단해야 한다.

    `TestClient` 를 컨텍스트 매니저로 진입하면 lifespan startup 이 실행된다.
    가드는 create_all/seed 보다 먼저 돌므로 DB 를 건드리지 않고 즉시 터진다.
    """
    monkeypatch.setattr(main_module, "settings", _prod_settings(jwt_secret=DEV_JWT_SECRET))

    with pytest.raises(RuntimeError) as exc:
        with TestClient(main_module.app):
            pytest.fail(
                "운영 설정이 위반인데 앱이 기동됐다 — lifespan 이 _verify_prod_settings() 를 "
                "호출하지 않는다(가드 함수만 남고 wiring 이 끊긴 상태)."
            )

    msg = str(exc.value)
    assert "JWT_SECRET" in msg
    assert DEV_JWT_SECRET in msg


def test_lifespan_starts_normally_when_env_is_not_prod(monkeypatch):
    """대조군: 비운영(ENV=test)이면 lifespan 이 정상 완료되고 앱이 요청을 받는다.

    이게 없으면 위 테스트는 'lifespan 이 무슨 이유로든 터지기만 하면' green 이라,
    가드가 아니라 엉뚱한 기동 실패를 통과로 오인할 수 있다.

    상태 오염 없음: lifespan 은 conftest 의 `client` 픽스처와 똑같은 일(create_all +
    seed_achievements/seed_sig_labels, 둘 다 멱등 upsert)만 한다. 데이터를 쓰는 뒤 테스트들은
    `client` 픽스처가 매번 drop_all/create_all 로 리셋하므로 영향을 받지 않는다.
    """
    monkeypatch.setattr(main_module, "settings", _prod_settings(env="test"))

    with TestClient(main_module.app) as c:
        assert c.get("/health").status_code == 200


# ── 1b. LOG_LEVEL (main.py 임포트 시점 로깅 설정) ──────────────────────────
# 모듈 임포트 시 1회 실행되는 코드라 in-process 로는 검사할 수 없다.
# test_dependency_isolation.py 와 같은 방식으로 깨끗한 인터프리터에서 확인한다.
_LOG_PROBE = (
    "import logging\n"
    "import src.main  # noqa\n"
    "print('ROOT_LEVEL=%d' % logging.getLogger().level)\n"
)


@pytest.mark.parametrize(
    ("log_level", "expected"),
    [
        ("DEBUG", 10),
        ("WARNING", 30),
        ("NOT_A_REAL_LEVEL", 20),  # 무효값 → INFO 폴백 (기동이 죽으면 안 된다)
    ],
)
def test_log_level_env_is_applied_with_info_fallback(log_level, expected):
    env = dict(os.environ)
    env["DATABASE_URL"] = "sqlite://"
    env["ENV"] = "test"
    env["JWT_SECRET"] = "test-secret-key"
    env["LOG_LEVEL"] = log_level

    result = subprocess.run(
        [sys.executable, "-c", _LOG_PROBE],
        cwd=str(_BACKEND),
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert f"ROOT_LEVEL={expected}" in result.stdout, result.stdout


# ── 2. PRAGMA foreign_keys 가 실제로 켜졌는가 ──────────────────────────────
def test_pragma_foreign_keys_is_on_for_engine_and_session():
    """앱이 실제로 쓰는 엔진/세션 커넥션에서 FK 강제가 켜져 있어야 한다."""
    assert engine.dialect.name == "sqlite", "테스트는 SQLite 전제(conftest 가 sqlite:// 주입)"

    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1

    db = SessionLocal()
    try:
        assert db.execute(text("PRAGMA foreign_keys")).scalar() == 1
    finally:
        db.close()


def test_pragma_applies_to_newly_created_connections():
    """리스너가 'connect' 이벤트에 걸려 있으므로 새로 만든 커넥션도 켜져 있어야 한다.

    테스트 DB 는 StaticPool(단일 공유 커넥션)이라 pool 에서 새 커넥션이 나오지 않는다.
    engine.pool.recreate() 는 같은 creator + 같은 이벤트 디스패치로 **새 풀**을 만들고
    기존 풀/커넥션은 건드리지 않으므로, 다른 테스트의 in-memory DB 를 날리지 않고
    '진짜 새 커넥션'을 하나 얻을 수 있다.
    """
    new_pool = engine.pool.recreate()
    try:
        conn = new_pool.connect()
        try:
            cursor = conn.driver_connection.cursor()
            try:
                cursor.execute("PRAGMA foreign_keys")
                assert cursor.fetchone()[0] == 1
            finally:
                cursor.close()
        finally:
            conn.close()
    finally:
        new_pool.dispose()

    # 원래 엔진은 멀쩡해야 한다(다른 테스트 보호)
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1


# ── 3·4. CASCADE / FK 거부 ────────────────────────────────────────────────
def _recent_started_at() -> str:
    """서버의 72시간 백데이트 하한을 항상 만족하는 '1시간 전'."""
    return (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _session_payload() -> dict:
    return {
        "clientSessionId": str(uuid.uuid4()),
        "exerciseType": "game_balloon",
        "startedAt": _recent_started_at(),
        "durationSec": 600,
        "score": 8,
        "avgForce": 55.0,
        "maxForce": 80.0,
        "attempts": 2,
        "difficulty": "medium",
        "handUsed": "right",
        "sets": [
            {"setIndex": 1, "reps": 5, "avgForce": 52.0, "peakForce": 70.0, "holdSec": 3},
            {"setIndex": 2, "reps": 6, "avgForce": 58.0, "peakForce": 78.0, "holdSec": 4},
        ],
    }


def _count(db, table: str) -> int:
    # 각 테스트마다 conftest 가 스키마를 drop/create 하므로 테이블에는 이 사용자 행만 있다.
    return db.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar_one()


def test_deleting_user_cascades_to_child_rows(client):
    """FK 강제의 실질적 목적: users 삭제 시 자식 행이 DB 레벨에서 함께 사라진다.

    **raw SQL DELETE 를 쓴다.** ORM 의 session.delete(user) 는 파이썬 relationship 이
    선언된 것만 처리하므로(User 에는 profile/settings 만 선언됨) DB 레벨 ON DELETE CASCADE
    가 아니라 SQLAlchemy 의 동작을 검증하게 된다. 여기서 확인하려는 건 DB 쪽 CASCADE 다.
    """
    email = "cascade@example.com"
    _, headers = register_and_auth(client, email=email)

    r = client.post("/api/v1/users/me/sessions", headers=headers, json=_session_payload())
    assert r.status_code == 201, r.text

    child_tables = [
        "profiles",
        "user_settings",
        "refresh_tokens",
        "sessions",
        "session_sets",
        "xp_events",
        "user_stats",
        "user_achievements",
    ]

    db = SessionLocal()
    try:
        user_id = db.execute(
            text("SELECT id FROM users WHERE email = :email"), {"email": email}
        ).scalar_one()

        # 삭제 전: 자식 행이 실제로 존재해야 테스트가 의미를 가진다
        before = {t: _count(db, t) for t in child_tables}
        assert all(n > 0 for n in before.values()), f"자식 행이 비어 있음: {before}"

        db.execute(text("DELETE FROM users WHERE id = :uid"), {"uid": user_id})
        db.commit()

        assert _count(db, "users") == 0
        after = {t: _count(db, t) for t in child_tables}
        assert after == {t: 0 for t in child_tables}, f"CASCADE 되지 않은 고아 행: {after}"
    finally:
        db.close()


def test_insert_with_unknown_user_id_is_rejected(client):
    """FK 가 꺼져 있으면 이 INSERT 가 조용히 성공한다 — 회귀를 잡는 핵심 테스트.

    CHECK 제약(exercise_type/duration/force/stars)은 전부 만족시켜, 실패 원인이
    오직 FK 위반임을 메시지로 확인한다.
    """
    ghost_user_id = str(uuid.uuid4())
    db = SessionLocal()
    try:
        with pytest.raises(IntegrityError) as exc:
            db.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, client_session_id, user_id, exercise_type, started_at, duration_sec, "
                    " set_count, avg_force, max_force, stars, attempts, created_at, updated_at) "
                    "VALUES "
                    "(:id, :csid, :uid, 'game_balloon', :started, 600, 8, 55.0, 80.0, 2, 1, "
                    " :now, :now)"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "csid": str(uuid.uuid4()),
                    "uid": ghost_user_id,
                    "started": datetime.now(timezone.utc).replace(tzinfo=None),
                    "now": datetime.now(timezone.utc).replace(tzinfo=None),
                },
            )
            db.commit()
        assert "FOREIGN KEY" in str(exc.value).upper(), str(exc.value)
    finally:
        db.rollback()
        db.close()

    # 고아 행이 남지 않았는지 확인
    db = SessionLocal()
    try:
        assert (
            db.execute(
                text("SELECT COUNT(*) FROM sessions WHERE user_id = :uid"),
                {"uid": ghost_user_id},
            ).scalar_one()
            == 0
        )
    finally:
        db.close()


def test_xp_event_with_unknown_user_id_is_rejected(client):
    """원장 테이블도 동일하게 보호된다(사용자 없는 XP 이벤트 = 집계 불변식 파괴)."""
    db = SessionLocal()
    try:
        with pytest.raises(IntegrityError) as exc:
            db.execute(
                text(
                    "INSERT INTO xp_events (user_id, amount, reason, created_at) "
                    "VALUES (:uid, 100, 'session', :now)"
                ),
                {
                    "uid": str(uuid.uuid4()),
                    "now": datetime.now(timezone.utc).replace(tzinfo=None),
                },
            )
            db.commit()
        assert "FOREIGN KEY" in str(exc.value).upper(), str(exc.value)
    finally:
        db.rollback()
        db.close()
