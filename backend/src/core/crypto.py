"""전화번호 애플리케이션 레벨 암호화 (AES-GCM).

06-security-compliance.md 결정: 전화번호는 DB 덤프 유출 시에도 키 없이 복호화 불가하도록
애플리케이션 레벨에서 AES-GCM 으로 암호화해 bytea(LargeBinary) 로 저장한다.
저장 포맷: nonce(12B) || ciphertext(+16B tag).
"""
from __future__ import annotations

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import settings

_NONCE_LEN = 12


def encrypt_phone(plaintext: str | None) -> bytes | None:
    if plaintext is None or plaintext == "":
        return None
    aes = AESGCM(settings.phone_key_bytes)
    nonce = os.urandom(_NONCE_LEN)
    ct = aes.encrypt(nonce, plaintext.encode("utf-8"), None)
    return nonce + ct


def decrypt_phone(blob: bytes | None) -> str | None:
    if not blob:
        return None
    aes = AESGCM(settings.phone_key_bytes)
    nonce, ct = blob[:_NONCE_LEN], blob[_NONCE_LEN:]
    return aes.decrypt(nonce, ct, None).decode("utf-8")
