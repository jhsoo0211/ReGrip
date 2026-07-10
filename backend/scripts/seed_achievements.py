"""업적 6종 시드 스크립트.

앱 startup 에서도 자동 upsert 되지만(main.lifespan), DB 를 수동으로 초기화하거나 운영에서
1회 시딩할 때 이 스크립트를 직접 실행한다.

    (venv) PS> python -m scripts.seed_achievements
"""
from __future__ import annotations

import sys
from pathlib import Path

# backend/ 를 import 경로에 추가 (scripts/ 에서 실행 시)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.core.db import SessionLocal, engine  # noqa: E402
from src.models import Base  # noqa: E402
from src.services.achievements import seed_achievements  # noqa: E402


def main() -> None:
    # SQLite 개발 DB 라면 테이블이 없을 수 있으니 생성 시도.
    if engine.dialect.name == "sqlite":
        Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        n = seed_achievements(db)
        print(f"seeded/updated {n} achievement definitions")
    finally:
        db.close()


if __name__ == "__main__":
    main()
