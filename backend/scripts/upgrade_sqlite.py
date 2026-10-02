"""Explicit, backup-first SQLite upgrade for session provenance (migrations 004 and 005).

Stop the API before running. Uses SQLite backup(), so committed WAL pages are included.
- 004: adds missing input_source / calibration_snapshot columns (ALTER TABLE ADD COLUMN).
- 005: widens a stale input_source CHECK to allow 'usb'. SQLite cannot ALTER a CHECK, so the
  sessions table SQL is edited with the documented writable_schema procedure for loosening
  constraints (lang_altertable.html, "Making Other Kinds Of Table Schema Changes"). Stored rows
  and the file format are untouched. An unrecognized input_source CHECK is refused, not guessed.
All changes run in one write transaction, followed by PRAGMA integrity_check after widening.
No table rebuild, deletion, source inference, or reward recomputation is performed.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3


_INPUT_SOURCE_CHECK = "input_source IN ('ble','usb','websocket','simulation','unknown')"
_ADD_COLUMNS = {
    "input_source": (
        "ALTER TABLE sessions ADD COLUMN input_source VARCHAR(16) NOT NULL DEFAULT 'unknown' "
        f"CHECK ({_INPUT_SOURCE_CHECK})"
    ),
    "calibration_snapshot": "ALTER TABLE sessions ADD COLUMN calibration_snapshot JSON",
}


def _in_list(*values: str) -> re.Pattern:
    return re.compile(r"input_source\s+(?i:IN)\s*\(\s*"
                      + r"\s*,\s*".join(f"'{value}'" for value in values) + r"\s*\)")


_OLD_CHECK_RE = _in_list("ble", "websocket", "simulation", "unknown")  # 004 vocabulary
_NEW_CHECK_RE = _in_list("ble", "usb", "websocket", "simulation", "unknown")
_CHECK_RE = re.compile(r"\bCHECK\s*\(", re.IGNORECASE)
_QUOTED_RE = re.compile(r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"")
_COLUMN_RE = re.compile(r"\binput_source\b")


def _session_columns(connection: sqlite3.Connection) -> set[str]:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
    required = {"id", "user_id", "client_session_id", "started_at", "result_snapshot"}
    if not required.issubset(columns):
        raise ValueError("기존 ReGrip sessions 테이블이 아닙니다. API 데이터베이스 경로를 확인하세요.")
    return columns


def _table_sql(connection: sqlite3.Connection) -> str:
    return connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").fetchone()[0]


def _input_source_checks(sql: str) -> list[tuple[int, int, bool]]:
    """(start, end, stale) of every CHECK body mentioning input_source; unknown forms are refused."""
    # Blank out quoted text (same length) so parentheses inside literals cannot shift the scan.
    masked = _QUOTED_RE.sub(lambda m: m.group(0)[0] + " " * (len(m.group(0)) - 2) + m.group(0)[-1], sql)
    found = []
    for match in _CHECK_RE.finditer(masked):
        depth = 0
        for end in range(match.end() - 1, len(masked)):
            depth += {"(": 1, ")": -1}.get(masked[end], 0)
            if depth == 0:
                break
        else:
            raise ValueError("sessions 테이블 SQL의 CHECK 괄호를 해석할 수 없습니다. 자동 변경하지 않습니다.")
        body = sql[match.end():end]
        if not _COLUMN_RE.search(body):
            continue
        if _OLD_CHECK_RE.fullmatch(body.strip()):
            found.append((match.end(), end, True))
        elif _NEW_CHECK_RE.fullmatch(body.strip()):
            found.append((match.end(), end, False))
        else:
            raise ValueError("인식할 수 없는 sessions.input_source CHECK입니다. 자동 변경하지 않습니다: "
                             + body.strip())
    return found


def _input_source_check_stale(sql: str) -> bool:
    return any(stale for _, _, stale in _input_source_checks(sql))


def _widen_input_source_check(connection: sqlite3.Connection) -> bool:
    """Loosen the 004 CHECK inside the caller's write transaction. Returns True when changed."""
    sql = _table_sql(connection)
    checks = _input_source_checks(sql)
    if not any(stale for _, _, stale in checks):
        return False
    new_sql = sql
    for start, end, stale in reversed(checks):
        if stale:
            body = _OLD_CHECK_RE.sub(lambda _: _INPUT_SOURCE_CHECK, new_sql[start:end])
            new_sql = new_sql[:start] + body + new_sql[end:]
    # A syntax error in sqlite_master would make the database unreadable: parse it on a blank DB first.
    with closing(sqlite3.connect(":memory:")) as probe:
        probe.execute(new_sql)
    version = connection.execute("PRAGMA schema_version").fetchone()[0]
    connection.execute("PRAGMA writable_schema=ON")
    try:
        if connection.execute("PRAGMA writable_schema").fetchone()[0] != 1:
            raise ValueError("SQLite defensive 모드로 writable_schema를 사용할 수 없어 "
                             "input_source CHECK를 확장하지 못했습니다.")
        try:
            updated = connection.execute(
                "UPDATE sqlite_master SET sql=? WHERE type='table' AND name='sessions' AND sql=?",
                (new_sql, sql)).rowcount
        except sqlite3.Error as exc:
            raise ValueError("SQLite가 스키마 수정을 거부했습니다(defensive 모드 등). "
                             "input_source CHECK를 확장하지 못했습니다.") from exc
        if updated != 1:
            raise ValueError("sessions 테이블 정의가 예상과 달라 input_source CHECK를 확장하지 못했습니다.")
        connection.execute(f"PRAGMA schema_version={int(version) + 1}")
    finally:
        connection.execute("PRAGMA writable_schema=OFF")
    return True


def _verify_widened(database: Path) -> None:
    # A fresh connection re-parses the edited schema; the upgrading connection keeps its old cache.
    with closing(sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=5)) as check:
        result = check.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok" or _input_source_check_stale(_table_sql(check)):
            raise ValueError(f"SQLite 무결성 검사 결과: {result}")


def upgrade_database(database: Path, *, dry_run: bool = False, backup_dir: Path | None = None) -> dict:
    database = Path(database).resolve(strict=True)
    if not database.is_file():
        raise ValueError("database는 기존 SQLite 파일이어야 합니다.")
    # mode=rw prevents a mistyped path from silently creating an empty database.
    connection = sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=5)
    backup_path = None
    committed = False
    try:
        columns = _session_columns(connection)
        missing = [name for name in _ADD_COLUMNS if name not in columns]
        stale = _input_source_check_stale(_table_sql(connection))
        if not (missing or stale) or dry_run:
            return {"changed": False, "missingColumns": missing, "staleInputSourceCheck": stale,
                    "backup": None, "dryRun": dry_run}
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("SQLite 무결성 검사에 실패했습니다. 업그레이드를 중단합니다.")

        destination = Path(backup_dir).resolve() if backup_dir else database.parent / ".backups"
        destination.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup_path = destination / f"{database.name}.pre-upgrade.{stamp}.bak"
        # Reserve exclusively; never replace a user's previous backup.
        with backup_path.open("xb"):
            pass
        with sqlite3.connect(backup_path) as backup_connection:
            connection.backup(backup_connection)
            if backup_connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("백업 검증에 실패했습니다. 원본은 변경하지 않았습니다.")

        connection.execute("BEGIN IMMEDIATE")
        try:
            # Re-inspect under the write lock so a completed concurrent upgrade is a no-op.
            columns = _session_columns(connection)
            applied = []
            for name, statement in _ADD_COLUMNS.items():
                if name not in columns:
                    connection.execute(statement)
                    applied.append(name)
            widened = _widen_input_source_check(connection)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        committed = True
        if widened:
            _verify_widened(database)
        return {"changed": bool(applied) or widened, "addedColumns": applied,
                "widenedInputSourceCheck": widened, "backup": str(backup_path), "dryRun": False}
    except Exception as exc:
        if backup_path is None:
            raise
        detail = str(exc).rstrip(".")
        if committed:
            raise RuntimeError(f"업그레이드 후 검증에 실패했습니다({detail}). API를 시작하지 말고 "
                               f"백업으로 복원하세요. 백업: {backup_path}") from exc
        raise RuntimeError(f"업그레이드 실패({detail}). 원본 변경은 롤백했습니다. 백업: {backup_path}") from exc
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path, help="기존 API SQLite DB 파일 경로")
    parser.add_argument("--dry-run", action="store_true",
                        help="누락 컬럼과 낡은 input_source CHECK만 검사; 백업/DB 변경 없음")
    parser.add_argument("--backup-dir", type=Path, help="기본: DB 옆 .backups 디렉터리")
    args = parser.parse_args()
    try:
        result = upgrade_database(args.database, dry_run=args.dry_run, backup_dir=args.backup_dir)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
