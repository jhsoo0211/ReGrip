"""sig_label 어휘 시드 (NinaPro DB2 동작 50행). achievements.seed_achievements 멱등 패턴 미러.

data/labels_ninapro_hand_v1.json 을 (scheme, code) 키로 upsert 한다. 2회 호출해도 안전(멱등).
운영(PostgreSQL)에서는 003_signal_catalog.sql 이 seed 를 담당하므로, 앱 startup 에서는
SQLite(개발/테스트)에서만 이 함수를 호출한다(main.py lifespan 참고).

파일 경로는 이 모듈 기준 상대경로로 잡는다(CWD 비의존): backend/src/services -> backend/data.
"""
from __future__ import annotations

import json
from pathlib import Path

# backend/src/services/signal_vocab.py -> parents[2] == backend
_LABELS_PATH = Path(__file__).resolve().parents[2] / "data" / "labels_ninapro_hand_v1.json"


def load_label_seeds() -> list[dict]:
    """labels_ninapro_hand_v1.json 을 로드해 라벨 seed 목록을 반환."""
    with _LABELS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def seed_sig_labels(db) -> int:
    """sig_label 어휘를 (scheme, code) 기준 upsert. 반환: upsert 건수. 멱등(2회 호출 안전)."""
    from ..models import SigLabel

    seeds = load_label_seeds()
    n = 0
    for seed in seeds:
        row = (
            db.query(SigLabel)
            .filter(SigLabel.scheme == seed["scheme"], SigLabel.code == seed["code"])
            .one_or_none()
        )
        if row is None:
            row = SigLabel(scheme=seed["scheme"], code=seed["code"])
            db.add(row)
        row.protocol_block = seed["protocol_block"]
        row.name = seed["name"]
        row.taxonomy_ref = seed.get("taxonomy_ref")
        n += 1
    db.commit()
    return n
