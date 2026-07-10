"""Pydantic v2 베이스: camelCase alias.

API 경계는 camelCase(프론트 DataService 계약), 내부는 snake_case.
alias_generator=to_camel 로 필드를 자동 변환하고, populate_by_name=True 로 두 이름 모두 허용한다.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )
