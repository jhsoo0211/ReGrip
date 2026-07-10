"""업적 라우터 (02-api-spec §5.2).

GET /achievements          : 전체 업적 정의(표시 순서).
GET /users/me/achievements : 내 진행 상태(진행도 실시간 산출 + unlocked_at 영속).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select

from ..core.db import get_db
from ..core.timeutil import iso_z
from ..models import AchievementDefinition, User, UserAchievement
from ..schemas.achievement import (
    AchievementDefListResponse,
    AchievementDefOut,
    UserAchievementListResponse,
    UserAchievementOut,
)
from ..services.achievements import AchievementContext, evaluate
from ..services.session_service import load_session_facts
from .deps import get_current_user

router = APIRouter(tags=["achievements"])


def _active_defs(db) -> list[AchievementDefinition]:
    return (
        db.execute(
            select(AchievementDefinition)
            .where(AchievementDefinition.is_active.is_(True))
            .order_by(AchievementDefinition.sort_order)
        )
        .scalars()
        .all()
    )


@router.get("/achievements", response_model=AchievementDefListResponse)
def list_achievement_defs(db=Depends(get_db)):
    defs = _active_defs(db)
    return AchievementDefListResponse(
        data=[
            AchievementDefOut(
                id=d.id,
                title=d.title,
                description=d.description,
                category=d.category,
                rarity=d.rarity,
                reward_xp=d.reward_xp,
                sort_order=d.sort_order,
            )
            for d in defs
        ]
    )


@router.get("/users/me/achievements", response_model=UserAchievementListResponse)
def my_achievements(user: User = Depends(get_current_user), db=Depends(get_db)):
    from datetime import datetime

    from ..core.timeutil import resolve_zone
    from ..models import UserSettings, UserStats
    from ..services.gamification import effective_streak

    stats = db.get(UserStats, user.id)
    # streak_days 업적 진행도도 읽기 시 감쇠된 streak 를 사용한다 (B3).
    us = db.get(UserSettings, user.id)
    zone = resolve_zone(us.timezone if us is not None else None)
    today = datetime.now(zone).date()
    current_streak = effective_streak(stats, today) if stats else 0
    ctx = AchievementContext(
        sessions=load_session_facts(db, user.id), current_streak=current_streak
    )

    # 영속된 unlocked_at 조회
    ua_rows = db.execute(
        select(UserAchievement).where(UserAchievement.user_id == user.id)
    ).scalars().all()
    unlocked_map = {r.achievement_id: r.unlocked_at for r in ua_rows}

    out: list[UserAchievementOut] = []
    for d in _active_defs(db):
        progress, target = evaluate(d.rule_type, d.rule_params, ctx)
        shown = min(progress, target)
        out.append(
            UserAchievementOut(
                id=d.id,
                title=d.title,
                description=d.description,
                category=d.category,
                rarity=d.rarity,
                reward_xp=d.reward_xp,
                progress=shown,
                target=target,
                progress_label=f"{shown}/{target}",
                unlocked_at=iso_z(unlocked_map.get(d.id)),
            )
        )
    return UserAchievementListResponse(data=out)
