"""회귀: 아바타 저장형 XSS 차단(D3, svg 거부/매직바이트 스니핑) + 크기 상한(D4)."""
from __future__ import annotations

import base64

from tests.conftest import register_and_auth

# 최소 유효 PNG 시그니처(매직 바이트) + 여백.
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _data_url(mime: str, raw: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


# ── D3: SVG 는 415 로 거부 ───────────────────────────────────────
def test_avatar_base64_svg_rejected(client):
    _, headers = register_and_auth(client)
    svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    r = client.put(
        "/api/v1/users/me/profile",
        headers=headers,
        json={"avatarBase64": _data_url("image/svg+xml", svg)},
    )
    assert r.status_code == 415, r.text
    assert r.json()["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"


def test_avatar_upload_svg_rejected(client):
    _, headers = register_and_auth(client)
    files = {"file": ("x.svg", b"<svg></svg>", "image/svg+xml")}
    r = client.post("/api/v1/users/me/avatar", headers=headers, files=files)
    assert r.status_code == 415, r.text


def test_avatar_mime_spoofing_rejected(client):
    """image/png 이라 주장해도 실제 바이트가 SVG 면 매직 바이트 스니핑으로 거부."""
    _, headers = register_and_auth(client)
    svg = b"<svg></svg>"
    r = client.put(
        "/api/v1/users/me/profile",
        headers=headers,
        json={"avatarBase64": _data_url("image/png", svg)},
    )
    assert r.status_code == 415, r.text


def test_avatar_valid_png_accepted(client):
    _, headers = register_and_auth(client)
    r = client.put(
        "/api/v1/users/me/profile",
        headers=headers,
        json={"avatarBase64": _data_url("image/png", _PNG)},
    )
    assert r.status_code == 200, r.text
    assert r.json()["avatarUrl"].endswith(".png")


# ── D4: 2MiB 초과 → 413 ──────────────────────────────────────────
def test_avatar_base64_oversized_rejected(client):
    _, headers = register_and_auth(client)
    raw = _PNG + b"\x00" * (3 * 1024 * 1024)  # 약 3 MiB (유효 PNG 시그니처지만 크기 초과)
    r = client.put(
        "/api/v1/users/me/profile",
        headers=headers,
        json={"avatarBase64": _data_url("image/png", raw)},
    )
    assert r.status_code == 413, r.text
    assert r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_avatar_upload_oversized_rejected(client):
    _, headers = register_and_auth(client)
    raw = _PNG + b"\x00" * (3 * 1024 * 1024)
    files = {"file": ("big.png", raw, "image/png")}
    r = client.post("/api/v1/users/me/avatar", headers=headers, files=files)
    assert r.status_code == 413, r.text
    assert r.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"
