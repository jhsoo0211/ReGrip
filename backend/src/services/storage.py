"""아바타 저장 (로컬 파일시스템 → /static URL).

MVP: 오브젝트 스토리지(S3/presigned URL) 대신 backend/storage/avatars/ 에 저장하고
StaticFiles 로 /static/avatars/... 로 서빙한다(06 결정의 로컬 버전). S3 전환은 추후.
"""
from __future__ import annotations

import base64
import binascii
import re
import uuid
from pathlib import Path

from ..core.config import settings
from ..core.errors import AppError

_DATA_URL_RE = re.compile(r"^data:(?P<mime>image/[\w.+-]+)?;base64,(?P<data>.+)$", re.DOTALL)
_MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
}


def _avatars_dir() -> Path:
    d = Path(settings.storage_dir) / "avatars"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_avatar_base64(user_id: str, data_url: str) -> str:
    """data URL(base64) 를 디코드해 저장하고 /static URL 을 반환."""
    m = _DATA_URL_RE.match(data_url.strip())
    if m:
        mime = m.group("mime") or "image/png"
        b64 = m.group("data")
    else:
        # 순수 base64(헤더 없음) 도 허용
        mime, b64 = "image/png", data_url.strip()
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise AppError(422, "VALIDATION_FAILED", "avatarBase64 디코드에 실패했습니다.", {"field": "avatarBase64"})
    ext = _MIME_EXT.get(mime, "png")
    return _write(user_id, raw, ext)


def save_avatar_bytes(user_id: str, raw: bytes, content_type: str | None) -> str:
    ext = _MIME_EXT.get((content_type or "").lower(), "png")
    return _write(user_id, raw, ext)


def _write(user_id: str, raw: bytes, ext: str) -> str:
    fname = f"{user_id}_{uuid.uuid4().hex[:8]}.{ext}"
    (_avatars_dir() / fname).write_bytes(raw)
    return f"/static/avatars/{fname}"
