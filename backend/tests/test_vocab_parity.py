"""labels_ninapro_hand_v1.json 무결성 + seed_sig_labels 멱등/일치 검증.

- JSON: 정확히 50행, scheme 전부 'ninapro_db2', code 0-49 연속·유니크,
        block 분포(0=null, 1-17=B, 18-40=C, 41-49=D).
- seed 후 sig_label 행수·값이 JSON 과 일치. 2회 seed 해도 50행 유지(멱등).
- 앱 게임 슬러그(game_balloon 등)가 sig_label 에 절대 침투하지 않음(P6: 코퍼스 어휘에 앱 어휘 금지).
"""
from __future__ import annotations

from src.core.db import SessionLocal, engine
from src.models import Base, SigLabel
from src.services.signal_vocab import load_label_seeds, seed_sig_labels

# 앱(ReGrip) 게임/운동 슬러그 — 신호 카탈로그 어휘에 섞이면 안 된다.
_APP_GAME_SLUGS = {
    "game_balloon", "game_crane", "game_rhythm", "game_glide",
    "pinch_hold", "full_grip", "finger_ext", "lateral_grip",
}


def _expected_block(code: int) -> str | None:
    if code == 0:
        return None
    if 1 <= code <= 17:
        return "B"
    if 18 <= code <= 40:
        return "C"
    if 41 <= code <= 49:
        return "D"
    raise AssertionError(f"code out of expected range: {code}")


def test_json_shape():
    seeds = load_label_seeds()
    assert len(seeds) == 50
    codes = [s["code"] for s in seeds]
    assert sorted(codes) == list(range(50))  # 0-49 연속·유니크
    for s in seeds:
        assert s["scheme"] == "ninapro_db2"
        assert s["protocol_block"] == _expected_block(s["code"])
        assert s["name"] not in _APP_GAME_SLUGS
    rest = next(s for s in seeds if s["code"] == 0)
    assert rest["name"] == "rest"


def test_seed_idempotent_and_matches_json():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_sig_labels(db)
        assert db.query(SigLabel).count() == 50
        # 2회 seed → 여전히 50행(멱등)
        seed_sig_labels(db)
        assert db.query(SigLabel).count() == 50

        by_code = {s["code"]: s for s in load_label_seeds()}
        rows = db.query(SigLabel).all()
        assert len(rows) == 50
        for r in rows:
            assert r.scheme == "ninapro_db2"
            exp = by_code[r.code]
            assert r.name == exp["name"]
            assert r.protocol_block == exp["protocol_block"]
            # 앱 게임 어휘 침투 금지
            assert r.name not in _APP_GAME_SLUGS
            assert r.scheme not in _APP_GAME_SLUGS
    finally:
        db.close()
