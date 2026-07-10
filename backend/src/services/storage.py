"""아바타 저장 (로컬 파일시스템 → /static URL).

MVP: 오브젝트 스토리지(S3/presigned URL) 대신 backend/storage/avatars/ 에 저장하고
StaticFiles 로 /static/avatars/... 로 서빙한다(06 결정의 로컬 버전). S3 전환은 추후.

보안(D3): 저장형 XSS 를 막기 위해 SVG 를 허용 목록에서 제외하고, 선언된 MIME 대신
**실제 매직 바이트**로 포맷을 판정한다(png/jpeg/webp 만 허용). 스니핑에 실패하면 415.
크기(D4): 디코드 후 avatar_max_bytes(기본 2 MiB) 초과 시 413.
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


def _avatars_dir() -> Path:
    d = Path(settings.storage_dir) / "avatars"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sniff_ext(raw: bytes) -> str | None:
    """매직 바이트로 실제 이미지 포맷을 판정. 허용 포맷이 아니면 None (svg/gif 등 거부)."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if raw[:3] == b"\xff\xd8\xff":  # JPEG (SOI + marker)
        return "jpg"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "webp"
    return None


def _validate_size(raw: bytes) -> None:
    if len(raw) > settings.avatar_max_bytes:
        limit_mib = settings.avatar_max_bytes // (1024 * 1024)
        raise AppError(
            413,
            "PAYLOAD_TOO_LARGE",
            f"아바타 크기가 상한({limit_mib}MiB)을 초과했습니다.",
            {"field": "avatar"},
        )


def _resolve_ext(raw: bytes) -> str:
    """크기(413) → 포맷(415) 순으로 검증하고 확장자를 돌려준다."""
    _validate_size(raw)
    ext = _sniff_ext(raw)
    if ext is None:
        raise AppError(
            415,
            "UNSUPPORTED_MEDIA_TYPE",
            "지원하지 않는 이미지 형식입니다(png/jpeg/webp 만 허용).",
            {"field": "avatar"},
        )
    return ext


def save_avatar_base64(user_id: str, data_url: str) -> str:
    """data URL(base64) 를 디코드해 저장하고 /static URL 을 반환."""
    m = _DATA_URL_RE.match(data_url.strip())
    b64 = m.group("data") if m else data_url.strip()
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise AppError(
            422, "VALIDATION_FAILED", "avatarBase64 디코드에 실패했습니다.", {"field": "avatarBase64"}
        )
    # 선언 MIME 은 신뢰하지 않는다 — 실제 바이트로 크기/포맷 판정.
    ext = _resolve_ext(raw)
    return _write(user_id, raw, ext)


def save_avatar_bytes(user_id: str, raw: bytes, content_type: str | None) -> str:
    # content_type 은 무시하고 매직 바이트로 판정(스푸핑 방지).
    ext = _resolve_ext(raw)
    return _write(user_id, raw, ext)


def _write(user_id: str, raw: bytes, ext: str) -> str:
    fname = f"{user_id}_{uuid.uuid4().hex[:8]}.{ext}"
    (_avatars_dir() / fname).write_bytes(raw)
    return f"/static/avatars/{fname}"
