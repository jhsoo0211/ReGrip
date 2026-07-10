"""ReGrip API 진입점.

FastAPI 앱: /api/v1 라우터, CORS(로컬 프론트 화이트리스트), 에러 envelope 핸들러,
StaticFiles(/static → storage, 아바타), startup 시 SQLite 테이블 생성 + 업적 6종 upsert.
"""
from __future__ import annotations

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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 개발/테스트(SQLite): ORM 모델로 테이블 자동 생성.
    # 운영(PostgreSQL): migrations/001_init.sql 로 스키마를 관리하므로 여기서 만들지 않는다.
    if engine.dialect.name == "sqlite":
        Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_achievements(db)  # 업적 6종 upsert (멱등)
    finally:
        db.close()
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
