"""SQL(migrations) ↔ ORM(Base.metadata) 의 명시이름 ck_* IN-list CHECK 어휘 일치 검증.

목적: enum 값목록이 SQL 과 ORM 에서 어긋나면(002 가 생긴 근본 원인) 즉시 red 로 잡는다.

대상: `CONSTRAINT ck_x CHECK (col IN ('a','b',...))` 형태의 CHECK 만 비교한다.
  - 001/003 의 컬럼 인라인 `CONSTRAINT ck_x CHECK (...)`
  - 002 의 `ALTER TABLE ... ADD CONSTRAINT ck_x CHECK (...)`
  - 같은 이름이 여러 번 정의되면 파일/텍스트 순서상 뒤(later ALTER)가 이긴다.

제외(스킵): IN-list 가 아닌 CHECK — 정규식(~)/범위(BETWEEN,>,<)/`X IS NULL OR ...`/bool 식.
  파서가 이런 형태를 값집합으로 오인하지 않도록 CHECK 본문 전체가 `col IN (...)` 일 때만 채택한다.
"""
from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import CheckConstraint

from src.models import Base

_BACKEND = Path(__file__).resolve().parents[1]
_MIGRATIONS = _BACKEND / "migrations"
_SQL_FILES = ["001_init.sql", "002_game_types.sql", "003_signal_catalog.sql"]

# 한쪽(SQL/ORM)에만 존재하는 것이 정당한, 알려진 ck_* 예외.
#   - ck_sig_blob_relpath : PG 전용 정규식(~) CHECK. SQLite 미지원 → ORM 에 없음(003 SQL only).
#                           (정규식은 IN-list 도 아니라 애초에 파서가 값집합으로 잡지 않는다.)
#   - ck_sessions_difficulty : 002 가 SQL 에서 명시명을 부여하지만 ORM sessions 에는 difficulty
#                              CHECK 자체가 없다(SQL only).
#   - 나머지 : 001 이 익명 인라인 CHECK 로 정의 → 파서가 ck_* 로 못 잡는다. ORM 만 명시명을
#             갖는 레거시(이 작업 범위 밖). 값 자체는 001 과 동일하다.
_SKIP = {
    "ck_sig_blob_relpath",     # SQL-only 정규식
    "ck_sessions_difficulty",  # SQL-only (ORM 미보유)
    # ↓ 001 익명 인라인 CHECK → ORM-only 명시명 (레거시)
    "ck_users_role",
    "ck_users_status",
    "ck_profiles_gender",
    "ck_profiles_hand",
    "ck_profiles_injury",
    "ck_settings_hand",
    "ck_ach_category",
    "ck_ach_rarity",
    "ck_ach_rule_type",
    "ck_xp_reason",
}

_CONSTRAINT_RE = re.compile(r"CONSTRAINT\s+(ck_\w+)\s+CHECK\s*", re.IGNORECASE)
# CHECK 본문 전체가 정확히 `col IN ( ... )` 일 때만 IN-list 로 인정(IS NULL OR / 범위 / 정규식 배제).
_INLIST_RE = re.compile(r"^\s*(\w+)\s+IN\s*\(\s*(.*?)\s*\)\s*$", re.IGNORECASE | re.DOTALL)
_QUOTED_RE = re.compile(r"'([^']*)'")


def _balanced(text: str, open_idx: int) -> str:
    """text[open_idx] == '(' 에서 시작해 짝 맞는 ')' 까지의 내부 문자열을 반환."""
    assert text[open_idx] == "("
    depth = 0
    for i in range(open_idx, len(text)):
        c = text[i]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1 : i]
    raise ValueError("unbalanced parentheses in CHECK body")


def _inlist_values(body: str) -> frozenset[str] | None:
    """CHECK 본문이 `col IN ('a','b',...)` 이면 값집합, 아니면 None."""
    m = _INLIST_RE.match(body)
    if not m:
        return None
    values = frozenset(_QUOTED_RE.findall(m.group(2)))
    return values or None


def _extract_sql(sql: str) -> dict[str, frozenset[str]]:
    """SQL 텍스트에서 명시이름 ck_* 의 IN-list 값집합을 {name: frozenset(values)} 로."""
    out: dict[str, frozenset[str]] = {}
    for m in _CONSTRAINT_RE.finditer(sql):
        name = m.group(1)
        paren = sql.find("(", m.end() - 1)
        if paren == -1:
            continue
        values = _inlist_values(_balanced(sql, paren))
        if values is not None:
            out[name] = values  # 같은 이름이면 뒤(later)가 이긴다
    return out


def _sql_inlist_checks() -> dict[str, frozenset[str]]:
    merged: dict[str, frozenset[str]] = {}
    for fname in _SQL_FILES:
        merged.update(_extract_sql((_MIGRATIONS / fname).read_text(encoding="utf-8")))
    return merged


def _orm_inlist_checks() -> dict[str, frozenset[str]]:
    out: dict[str, frozenset[str]] = {}
    for table in Base.metadata.tables.values():
        for c in table.constraints:
            if not isinstance(c, CheckConstraint):
                continue
            if not c.name or not c.name.startswith("ck_"):
                continue
            values = _inlist_values(str(c.sqltext))
            if values is not None:
                out[c.name] = values
    return out


def test_sql_parser_covers_known_checks():
    """파서 자체 회귀: 002/003 의 대표 IN-list CHECK 를 실제로 뽑아야 한다."""
    sql = _sql_inlist_checks()
    assert "ck_sessions_exercise_type" in sql       # 002 ALTER ADD 형태
    assert "ck_sig_chan_modality" in sql            # 003 인라인 형태
    assert sql["ck_sig_chan_unit"] == frozenset(
        {"mV", "g", "deg", "mvc_frac", "n_raw", "N", "n/a"}
    )
    assert sql["ck_sig_dataset_license"] == frozenset(
        {"unverified", "citation-only", "cc0-1.0", "cc-by-4.0", "cc-by-nd-4.0", "custom-permission"}
    )
    # 정규식/범위/IS NULL OR CHECK 는 IN-list 가 아니므로 잡히면 안 된다.
    assert "ck_sig_blob_relpath" not in sql
    assert "ck_sig_seg_order" not in sql
    assert "ck_sig_label_block" not in sql
    assert "ck_sig_subject_sex" not in sql


def test_orm_sql_inlist_checks_match():
    sql = _sql_inlist_checks()
    orm = _orm_inlist_checks()

    # 1) 양쪽에 모두 있는 이름은 값집합이 정확히 일치해야 한다(핵심 어휘 드리프트 방지).
    for name in sorted(set(sql) & set(orm)):
        assert sql[name] == orm[name], (
            f"{name}: SQL={sorted(sql[name])} != ORM={sorted(orm[name])}"
        )

    # 2) 한쪽에만 있는 ck_* IN-list 는 스킵 목록에 있어야 한다(그 외엔 실패).
    only_sql = set(sql) - set(orm) - _SKIP
    only_orm = set(orm) - set(sql) - _SKIP
    assert not only_sql, f"SQL 에만 있는 ck_* IN-list: {sorted(only_sql)}"
    assert not only_orm, f"ORM 에만 있는 ck_* IN-list: {sorted(only_orm)}"

    # 3) 이 작업의 핵심 보증: 모든 sig_* IN-list CHECK 는 SQL·ORM 양쪽에 동일하게 존재해야 한다.
    sig_sql = {n for n in sql if n.startswith("ck_sig_")}
    sig_orm = {n for n in orm if n.startswith("ck_sig_")}
    assert sig_sql == sig_orm, f"sig_* IN-list 불일치: SQL={sorted(sig_sql)} ORM={sorted(sig_orm)}"
    assert sig_sql, "sig_* IN-list CHECK 가 하나도 안 잡혔다(파서/스키마 회귀)"
