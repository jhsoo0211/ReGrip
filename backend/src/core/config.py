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
    # 백데이트 허용 하한(시간). 오프라인 큐 재전송을 허용하는 폭이며, 이를 넘는 과거
    # startedAt 은 422 로 거부한다(무제한 백데이트/일일상한 우회 차단).
    backdate_limit_hours: int = 72
    # 사용자 기본 타임존(IANA). user_settings.timezone 미설정/무효 시 폴백.
    default_timezone: str = "Asia/Seoul"
    # 아바타 업로드 크기 상한(바이트). 기본 2 MiB.
    avatar_max_bytes: int = 2 * 1024 * 1024

    # 정적 파일(아바타) 저장 경로
    storage_dir: str = "./storage"

    # 로깅 레벨 (DEBUG | INFO | WARNING | ERROR | CRITICAL). main.py 의 basicConfig 가 사용.
    log_level: str = "INFO"

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
