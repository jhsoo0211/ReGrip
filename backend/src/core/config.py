"""애플리케이션 설정 (.env 로드).

pydantic-settings 로 환경변수를 읽는다. 필드명(snake_case)은 대소문자 무시로
환경변수에 매핑된다(예: database_url -> DATABASE_URL). 운영 전환은 DATABASE_URL 하나로 끝난다.
"""
from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # DB
    database_url: str = "sqlite:///./regrip_dev.db"

    # 배포 환경: dev | test | prod
    env: str = "dev"

    # JWT
    jwt_secret: str = "dev-insecure-change-me"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 14

    # 전화번호 AES-GCM 키 (base64 urlsafe, 32바이트). 비면 dev 고정 키 유도.
    phone_enc_key: str = ""

    # CORS 화이트리스트 (콤마 구분 문자열)
    cors_origins: str = (
        "http://localhost:5500,http://127.0.0.1:5500,"
        "http://localhost:8000,http://127.0.0.1:8000,http://localhost:3000"
    )

    # 도메인 규칙
    max_daily_sessions: int = 20
    started_at_skew_sec: int = 300

    # 정적 파일(아바타) 저장 경로
    storage_dir: str = "./storage"

    @property
    def is_prod(self) -> bool:
        return self.env.lower() == "prod"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def phone_key_bytes(self) -> bytes:
        """AES-GCM 용 32바이트 키를 돌려준다.

        phone_enc_key 가 비어 있으면 jwt_secret 에서 결정적으로 유도한 dev 키를 쓴다
        (운영에서는 반드시 phone_enc_key 를 명시해야 한다).
        """
        if self.phone_enc_key:
            raw = base64.urlsafe_b64decode(self.phone_enc_key)
            if len(raw) != 32:
                raise ValueError("PHONE_ENC_KEY must decode to 32 bytes")
            return raw
        # dev 폴백: 고정 키를 secret 에서 유도
        return hashlib.sha256(("phone::" + self.jwt_secret).encode()).digest()


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
