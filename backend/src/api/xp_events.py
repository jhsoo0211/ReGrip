"""XP 원장 조회 라우터 (02-api-spec §5.3)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from ..core.db import get_db
from ..core.timeutil import iso_z
from ..models import User, XpEvent
from ..schemas.stats import XpEventListResponse, XpEventOut
from .deps import get_current_user

router = APIRouter(prefix="/users/me", tags=["xp"])


@router.get("/xp-events", response_model=XpEventListResponse)
def list_xp_events(
    user: User = Depends(get_current_user),
    db=Depends(get_db),
    limit: int = Query(default=10, ge=1, le=100),
):
    rows = db.execute(
        select(XpEvent)
        .where(XpEvent.user_id == user.id)
        .order_by(XpEvent.created_at.desc(), XpEvent.id.desc())
        .limit(limit)
    ).scalars().all()
    return XpEventListResponse(
        data=[
            XpEventOut(
                amount=e.amount,
                reason=e.reason,
                ref_type=e.ref_type,
                ref_id=e.ref_id,
                created_at=iso_z(e.created_at),
            )
            for e in rows
        ]
    )
