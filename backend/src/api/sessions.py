"""세션 라우터 (02-api-spec §4): 커서 페이지네이션 목록 / 저장 / 상세."""
from __future__ import annotations

import base64
import json
from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import and_, or_, select

from ..core.db import get_db
from ..core.errors import AppError
from ..core.timeutil import iso_z
from ..models import Session as SessionModel, User
from ..schemas.session import (
    SessionCreate,
    SessionDetail,
    SessionListMeta,
    SessionListResponse,
    SessionSetOut,
    SessionSummary,
)
from ..services.labels import label_for
from ..services.session_service import process_session_submission
from .deps import get_current_user

router = APIRouter(prefix="/users/me", tags=["sessions"])


def _encode_cursor(started_at: datetime, sid: str) -> str:
    payload = json.dumps({"s": started_at.isoformat(), "id": sid})
    return base64.urlsafe_b64encode(payload.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
        return datetime.fromisoformat(data["s"]), data["id"]
    except Exception:
        raise AppError(400, "BAD_REQUEST", "잘못된 cursor 입니다.", {"field": "cursor"})


def _summary(s: SessionModel) -> SessionSummary:
    return SessionSummary(
        id=s.id,
        client_session_id=s.client_session_id,
        date=iso_z(s.started_at),
        exercise_type=s.exercise_type,
        label=label_for(s.exercise_type),
        duration_min=round(s.duration_sec / 60),
        sets=s.set_count,
        avg_force=float(s.avg_force),
        max_force=float(s.max_force),
        stars=s.stars,
    )


@router.get("/sessions", response_model=SessionListResponse)
def list_sessions(
    user: User = Depends(get_current_user),
    db=Depends(get_db),
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = Query(default=None, alias="to"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
):
    q = select(SessionModel).where(SessionModel.user_id == user.id)
    if from_ is not None:
        q = q.where(SessionModel.started_at >= datetime.combine(from_, time.min))
    if to is not None:
        q = q.where(SessionModel.started_at < datetime.combine(to, time.min) + timedelta(days=1))
    if cursor:
        c_started, c_id = _decode_cursor(cursor)
        # keyset (started_at DESC, id DESC)
        q = q.where(
            or_(
                SessionModel.started_at < c_started,
                and_(SessionModel.started_at == c_started, SessionModel.id < c_id),
            )
        )
    q = q.order_by(SessionModel.started_at.desc(), SessionModel.id.desc()).limit(limit + 1)
    rows = db.execute(q).scalars().all()

    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = _encode_cursor(rows[-1].started_at, rows[-1].id) if has_more and rows else None
    return SessionListResponse(
        data=[_summary(s) for s in rows],
        meta=SessionListMeta(next_cursor=next_cursor, limit=limit),
    )


@router.post("/sessions")
def create_session(
    body: SessionCreate, user: User = Depends(get_current_user), db=Depends(get_db)
):
    status_code, result = process_session_submission(db, user, body)
    return JSONResponse(status_code=status_code, content=result)


@router.get("/sessions/{session_id}", response_model=SessionDetail)
def get_session(
    session_id: str, user: User = Depends(get_current_user), db=Depends(get_db)
):
    s = db.execute(
        select(SessionModel).where(
            SessionModel.id == session_id, SessionModel.user_id == user.id
        )
    ).scalar_one_or_none()
    if s is None:
        raise AppError(404, "NOT_FOUND", "세션을 찾을 수 없습니다.")
    return SessionDetail(
        id=s.id,
        exercise_type=s.exercise_type,
        label=label_for(s.exercise_type),
        started_at=iso_z(s.started_at),
        duration_min=round(s.duration_sec / 60),
        set_count=s.set_count,
        avg_force=float(s.avg_force),
        max_force=float(s.max_force),
        stars=s.stars,
        force_series=s.force_series,
        sets=[
            SessionSetOut(
                set_index=st.set_index,
                reps=st.reps,
                avg_force=float(st.avg_force) if st.avg_force is not None else None,
                peak_force=float(st.peak_force) if st.peak_force is not None else None,
                hold_sec=st.hold_sec,
            )
            for st in s.sets
        ],
    )
