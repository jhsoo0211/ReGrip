"""인증 요청/응답 스키마 (02-api-spec §2)."""
from __future__ import annotations

from datetime import date, datetime

from pydantic import EmailStr, Field

from .base import CamelModel


class SignupProfile(CamelModel):
    name: str
    birth_date: date | None = None


class Consents(CamelModel):
    sensitive_data: bool = False
    sensitive_data_at: datetime | None = None
    terms_of_service: bool = False
    guardian_consent: bool | None = None


class SignupRequest(CamelModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    profile: SignupProfile
    consents: Consents


class LoginRequest(CamelModel):
    email: EmailStr
    password: str


class UserOut(CamelModel):
    id: str
    email: str
    role: str


class TokenResponse(CamelModel):
    access_token: str
    expires_in: int
    user: UserOut
