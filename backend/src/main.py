"""ReGrip API 진입점.

FastAPI 앱: /api/v1 라우터, CORS(로컬 프론트 화이트리스트), 에러 envelope 핸들러,
StaticFiles(/static → storage, 아바타), startup 시 SQLite 테이블 생성 + 업적 6종 upsert.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import (
    achievements,
    auth,
    calibrations,
    health,
    profile,
    sessions,
    stats,
    xp_events,
)
from .api import settings as settings_api
from .core.config import settings
from .core.db import SessionLocal, engine
from .core.errors import register_error_handlers
from .models import Base
from .services.achievements import seed_achievements

# ── 로깅 기본 설정 ──────────────────────────────────────────────
# LOG_LEVEL 로 조절(기본 INFO). uvicorn/gunicorn 등이 이미 루트 핸들러를 붙였다면
# basicConfig 는 아무 것도 하지 않으므로(force 미사용) 기존 설정을 덮어쓰지 않는다.
_log_level = getattr(logging, settings.log_level.upper(), None)
if not isinstance(_log_level, int):
    _log_level = logging.INFO
logging.basicConfig(
    level=_log_level,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)

# 운영에서 반드시 교체해야 하는 개발용 기본 시크릿 (core/config.py 의 jwt_secret 기본값)
_DEV_JWT_SECRET = "dev-insecure-change-me"
_JWT_SECRET_MIN_LEN = 32
_SECRET_GEN_HINT = 'python -c "import secrets; print(secrets.token_urlsafe(48))"'
_PHONE_KEY_GEN_HINT = (
    'python -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"'
)


def _verify_prod_settings() -> None:
    """운영(ENV=prod) 기동 전 필수 설정을 검사하고, 위반이 있으면 기동을 중단한다.

    .env 를 빠뜨린 운영 배포가 조용히 성공하면 공개된 기본 시크릿으로 토큰 위조가 가능하고,
    개발용 SQLite 파일이 운영 DB 로 쓰인다. 위반 항목은 전부 모아 한 번에 보고해
    "하나 고치고 재기동"하는 왕복을 없앤다. ENV 가 prod 가 아니면 아무 것도 하지 않는다.
    """
    if not settings.is_prod:
        return

    problems: list[str] = []

    if settings.jwt_secret == _DEV_JWT_SECRET:
        problems.append(
            f"JWT_SECRET 이 개발용 기본값('{_DEV_JWT_SECRET}') 그대로입니다. "
            "공개된 값이라 누구나 액세스 토큰을 위조할 수 있습니다.\n"
            f"     → .env 에 JWT_SECRET 을 {_JWT_SECRET_MIN_LEN}자 이상 무작위 값으로 설정하세요. "
            f"생성: {_SECRET_GEN_HINT}"
        )
    elif len(settings.jwt_secret) < _JWT_SECRET_MIN_LEN:
        problems.append(
            f"JWT_SECRET 길이가 {len(settings.jwt_secret)}자로 너무 짧습니다"
            f"(최소 {_JWT_SECRET_MIN_LEN}자).\n"
            f"     → .env 의 JWT_SECRET 을 더 긴 무작위 값으로 교체하세요. "
            f"생성: {_SECRET_GEN_HINT}"
        )

    if not settings.phone_enc_key:
        problems.append(
            "PHONE_ENC_KEY 가 비어 있습니다. 비어 있으면 전화번호 암호화 키가 "
            "JWT_SECRET 에서 유도되어, JWT_SECRET 이 유출되면 전화번호까지 복호화됩니다.\n"
            "     → .env 에 PHONE_ENC_KEY 를 설정하세요(32바이트 base64url). "
            f"생성: {_PHONE_KEY_GEN_HINT}"
        )

    if settings.database_url.startswith("sqlite"):
        problems.append(
            f"DATABASE_URL 이 SQLite 입니다('{settings.database_url}'). "
            "운영은 PostgreSQL 을 써야 합니다(동시성·백업·마이그레이션).\n"
            "     → .env 의 DATABASE_URL 을 PostgreSQL DSN 으로 바꾸세요. "
            "예: postgresql+psycopg://user:password@host:5432/regrip"
        )

    if problems:
        lines = "\n".join(f"  {i}. {p}" for i, p in enumerate(problems, start=1))
        raise RuntimeError(
            f"운영 환경(ENV=prod) 설정 검증에 실패했습니다. 아래 {len(problems)}건을 "
            "backend/.env 에서 모두 고친 뒤 다시 기동하세요.\n"
            f"{lines}\n"
            "  (설정 항목 전체 목록은 backend/.env.example 참고)"
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 운영 필수 설정 검증(fail-fast). 위반 시 RuntimeError 로 기동을 중단한다.
    _verify_prod_settings()

    # 개발/테스트(SQLite): ORM 모델로 테이블 자동 생성.
    # 운영(PostgreSQL): migrations/001_init.sql 로 스키마를 관리하므로 여기서 만들지 않는다.
    if engine.dialect.name == "sqlite":
        Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_achievements(db)  # 업적 6종 upsert (멱등)
        if engine.dialect.name == "sqlite":
            # 신호 카탈로그 라벨 어휘 seed. 운영(PG)은 003_signal_catalog.sql 이 담당하므로 SQLite 만.
            # sig 는 선택적 서브시스템이므로 지연 import 로 감싼다. sig 어휘 모듈이 없으면
            # seed 를 건너뛴다(경고 아님 — 파일 부재는 정상 상태다).
            try:
                from .services.signal_vocab import seed_sig_labels

                seed_sig_labels(db)
            except ImportError:
                logger.debug("신호 카탈로그(sig) 어휘 모듈이 없어 seed_sig_labels 를 건너뜁니다.")
    finally:
        db.close()
    logger.info("ReGrip API 기동 (env=%s, dialect=%s)", settings.env, engine.dialect.name)
    yield


app = FastAPI(title="ReGrip API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,  # 와일드카드 금지(06)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

register_error_handlers(app)

# 정적 파일(아바타) 서빙: /static/avatars/...
_storage = Path(settings.storage_dir)
(_storage / "avatars").mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_storage)), name="static")

# /api/v1 하위 라우터
api_v1 = APIRouter(prefix="/api/v1")
api_v1.include_router(auth.router)
api_v1.include_router(profile.router)
api_v1.include_router(settings_api.router)
api_v1.include_router(sessions.router)
api_v1.include_router(stats.router)
api_v1.include_router(achievements.router)
api_v1.include_router(xp_events.router)
api_v1.include_router(calibrations.router)
api_v1.include_router(health.router)
app.include_router(api_v1)

# 루트 헬스체크(/health) — 배포 헬스 프로브 편의
app.include_router(health.router)
