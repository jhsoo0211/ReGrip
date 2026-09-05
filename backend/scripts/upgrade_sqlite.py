"""Explicit, backup-first SQLite upgrade for session provenance (migration 004).

Stop the API before running. Uses SQLite backup(), so committed WAL pages are included.
No table rebuild, deletion, source inference, or reward recomputation is performed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


_ADD_COLUMNS = {
    "input_source": (
        "ALTER TABLE sessions ADD COLUMN input_source VARCHAR(16) NOT NULL DEFAULT 'unknown' "
        "CHECK (input_source IN ('ble','websocket','simulation','unknown'))"
    ),
    "calibration_snapshot": "ALTER TABLE sessions ADD COLUMN calibration_snapshot JSON",
}


def _session_columns(connection: sqlite3.Connection) -> set[str]:
    columns = {row[1] for row in connection.execute("PRAGMA table_info(sessions)")}
    required = {"id", "user_id", "client_session_id", "started_at", "result_snapshot"}
    if not required.issubset(columns):
        raise ValueError("기존 ReGrip sessions 테이블이 아닙니다. API 데이터베이스 경로를 확인하세요.")
    return columns


def upgrade_database(database: Path, *, dry_run: bool = False, backup_dir: Path | None = None) -> dict:
    database = Path(database).resolve(strict=True)
    if not database.is_file():
        raise ValueError("database는 기존 SQLite 파일이어야 합니다.")
    # mode=rw prevents a mistyped path from silently creating an empty database.
    connection = sqlite3.connect(database.as_uri() + "?mode=rw", uri=True, timeout=5)
    backup_path = None
    try:
        columns = _session_columns(connection)
        missing = [name for name in _ADD_COLUMNS if name not in columns]
        if not missing or dry_run:
            return {"changed": False, "missingColumns": missing, "backup": None, "dryRun": dry_run}
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("SQLite 무결성 검사에 실패했습니다. 업그레이드를 중단합니다.")

        destination = Path(backup_dir).resolve() if backup_dir else database.parent / ".backups"
        destination.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        backup_path = destination / f"{database.name}.pre-004.{stamp}.bak"
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
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        return {"changed": bool(applied), "addedColumns": applied,
                "backup": str(backup_path), "dryRun": False}
    except Exception as exc:
        if backup_path is not None:
            raise RuntimeError(f"업그레이드 실패. 원본 변경은 롤백했습니다. 백업: {backup_path}") from exc
        raise
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path, help="기존 API SQLite DB 파일 경로")
    parser.add_argument("--dry-run", action="store_true", help="누락 컬럼만 검사; 백업/DB 변경 없음")
    parser.add_argument("--backup-dir", type=Path, help="기본: DB 옆 .backups 디렉터리")
    args = parser.parse_args()
    try:
        result = upgrade_database(args.database, dry_run=args.dry_run, backup_dir=args.backup_dir)
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
