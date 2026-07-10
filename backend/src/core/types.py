"""크로스-DB 타입 폴백 (SQLAlchemy TypeDecorator).

PostgreSQL 운영 스키마(migrations/001_init.sql)의 uuid/jsonb/citext 를
SQLite 개발/테스트에서 각각 str(36)/JSON/String+lower 로 폴백한다.
동일 ORM 모델이 두 DB 모두에서 동작하게 하기 위한 경계 어댑터.
"""
from __future__ import annotations

from sqlalchemy.dialects.postgresql import JSONB as PG_JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.types import CHAR, JSON, TypeDecorator, String


class GUID(TypeDecorator):
    """uuid: PostgreSQL 는 native UUID, 그 외(SQLite)는 CHAR(36) 문자열.

    파이썬 측 값은 항상 str 로 다룬다(모델 기본값도 str(uuid4())).
    """

    impl = CHAR(36)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID(as_uuid=False))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return str(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return str(value)


class JSONB(TypeDecorator):
    """jsonb: PostgreSQL 는 JSONB, 그 외(SQLite)는 JSON."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_JSONB())
        return dialect.type_descriptor(JSON())


class CIText(TypeDecorator):
    """citext 폴백: 값 저장/조회 시 소문자로 정규화한다.

    PostgreSQL 운영 스키마는 citext 컬럼(대소문자 무시 유니크)이지만, ORM 은 이식성을 위해
    text/String 으로 두고 애플리케이션 레벨에서 소문자화한다. 두 DB 모두에서 이메일이
    사실상 대소문자 무시 유일성을 갖도록 보장한다(항상 lower 로 저장·조회).
    """

    impl = String
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return str(value).lower()

    def process_result_value(self, value, dialect):
        return value
