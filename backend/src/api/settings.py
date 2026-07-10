"""설정 라우터 (02-api-spec §3.4)."""
from __future__ import annotations

from datetime import time

from fastapi import APIRouter, Depends

from ..core.db import get_db
from ..models import User, UserSettings
from ..schemas.settings import SettingsOut, SettingsUpdate
from .deps import get_current_user

router = APIRouter(prefix="/users/me", tags=["settings"])


def _get_or_create(db, user: User) -> UserSettings:
    s = db.get(UserSettings, user.id)
    if s is None:
        s = UserSettings(user_id=user.id)
        db.add(s)
        db.flush()
    return s


def _to_out(s: UserSettings) -> SettingsOut:
    return SettingsOut(
        hand=s.hand,
        difficulty=s.difficulty,
        rest_seconds=s.rest_seconds,
        reminder_enabled=s.reminder_enabled,
        reminder_time=s.reminder_time.strftime("%H:%M") if s.reminder_time else "09:00",
        session_summary_enabled=s.session_summary_enabled,
    )


def _parse_hhmm(value: str) -> time:
    hh, mm = value.split(":")[:2]
    return time(int(hh), int(mm))


@router.get("/settings", response_model=SettingsOut)
def get_settings(user: User = Depends(get_current_user), db=Depends(get_db)):
    return _to_out(_get_or_create(db, user))


@router.put("/settings", response_model=SettingsOut)
def update_settings(body: SettingsUpdate, user: User = Depends(get_current_user), db=Depends(get_db)):
    s = _get_or_create(db, user)
    fields = body.model_dump(exclude_unset=True)
    if "hand" in fields:
        s.hand = fields["hand"]
    if "difficulty" in fields:
        s.difficulty = fields["difficulty"]
    if "rest_seconds" in fields and fields["rest_seconds"] is not None:
        s.rest_seconds = fields["rest_seconds"]
    if "reminder_enabled" in fields and fields["reminder_enabled"] is not None:
        s.reminder_enabled = fields["reminder_enabled"]
    if fields.get("reminder_time"):
        s.reminder_time = _parse_hhmm(fields["reminder_time"])
    if "session_summary_enabled" in fields and fields["session_summary_enabled"] is not None:
        s.session_summary_enabled = fields["session_summary_enabled"]
    db.commit()
    db.refresh(s)
    return _to_out(s)
