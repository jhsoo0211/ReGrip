"""프로필 라우터 (02-api-spec §3.1~3.3)."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, File, UploadFile

from ..core.config import settings
from ..core.crypto import decrypt_phone, encrypt_phone
from ..core.db import get_db
from ..core.errors import AppError
from ..models import Profile, User
from ..schemas.profile import AvatarOut, ProfileOut, ProfileUpdate
from ..services.storage import save_avatar_base64, save_avatar_bytes
from .deps import get_current_user

router = APIRouter(prefix="/users/me", tags=["profile"])

_AVATAR_READ_CHUNK = 64 * 1024


async def _read_limited(file: UploadFile, limit: int) -> bytes:
    """multipart 업로드를 청크 단위로 읽되 상한(limit) 초과 시 413 으로 즉시 중단한다 (D4)."""
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await file.read(_AVATAR_READ_CHUNK)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            limit_mib = limit // (1024 * 1024)
            raise AppError(
                413,
                "PAYLOAD_TOO_LARGE",
                f"아바타 크기가 상한({limit_mib}MiB)을 초과했습니다.",
                {"field": "file"},
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _compute_age(bd: date | None) -> int | None:
    if bd is None:
        return None
    today = date.today()
    return today.year - bd.year - ((today.month, today.day) < (bd.month, bd.day))


def _get_or_create_profile(db, user: User) -> Profile:
    p = db.get(Profile, user.id)
    if p is None:
        p = Profile(user_id=user.id, name="")
        db.add(p)
        db.flush()
    return p


def _to_out(p: Profile) -> ProfileOut:
    return ProfileOut(
        name=p.name,
        age=_compute_age(p.birth_date),
        birth_date=p.birth_date,
        gender=p.gender,
        phone=decrypt_phone(p.phone_enc),
        hand=p.dominant_hand,
        injury_type=p.injury_type,
        treatment_start=p.treatment_start,
        doctor_name=p.doctor_name,
        goal_force=p.goal_force,
        goal_days=p.goal_days,
        avatar_url=p.avatar_url,
    )


@router.get("/profile", response_model=ProfileOut)
def get_profile(user: User = Depends(get_current_user), db=Depends(get_db)):
    return _to_out(_get_or_create_profile(db, user))


@router.put("/profile", response_model=ProfileOut)
def update_profile(body: ProfileUpdate, user: User = Depends(get_current_user), db=Depends(get_db)):
    p = _get_or_create_profile(db, user)
    fields = body.model_dump(exclude_unset=True)

    if "name" in fields:
        p.name = fields["name"]
    if "birth_date" in fields:
        p.birth_date = fields["birth_date"]
    if "gender" in fields:
        p.gender = fields["gender"]
    if "phone" in fields:
        p.phone_enc = encrypt_phone(fields["phone"])
    if "hand" in fields:
        p.dominant_hand = fields["hand"]
    if "injury_type" in fields:
        p.injury_type = fields["injury_type"]
    if "treatment_start" in fields:
        p.treatment_start = fields["treatment_start"]
    if "doctor_name" in fields:
        p.doctor_name = fields["doctor_name"]
    if "goal_force" in fields:
        p.goal_force = fields["goal_force"]
    if "goal_days" in fields:
        p.goal_days = fields["goal_days"]
    # avatarBase64 과도기 호환: 디코드→저장→avatar_url 치환
    if fields.get("avatar_base64"):
        p.avatar_url = save_avatar_base64(user.id, fields["avatar_base64"])

    db.commit()
    db.refresh(p)
    return _to_out(p)


@router.post("/avatar", response_model=AvatarOut)
async def upload_avatar(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db=Depends(get_db),
):
    raw = await _read_limited(file, settings.avatar_max_bytes)
    url = save_avatar_bytes(user.id, raw, file.content_type)
    p = _get_or_create_profile(db, user)
    p.avatar_url = url
    db.commit()
    return AvatarOut(avatar_url=url)
