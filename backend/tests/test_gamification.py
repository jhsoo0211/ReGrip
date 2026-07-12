"""케이스 8 외: 게이미피케이션 순수 함수 단위 테스트 (레벨 경계/티어/별/세션 XP)."""
from __future__ import annotations

from src.services.gamification import (
    compute_stars,
    level_from_xp,
    session_xp,
    tier_for_level,
    xp_to_next,
)


def test_level_boundaries():
    # 케이스 8: xp 0 → L1, 100 → L2
    assert level_from_xp(0) == 1
    assert level_from_xp(99) == 1
    assert level_from_xp(100) == 2
    assert level_from_xp(224) == 2  # 100 + 125 = 225 부터 L3
    assert level_from_xp(225) == 3
    # 브리프 케이스 2 값
    assert level_from_xp(370) == 3
    # 1~100 클램프
    assert level_from_xp(10_000_000) == 100


def test_xp_to_next():
    assert xp_to_next(1) == 100
    assert xp_to_next(2) == 125
    assert xp_to_next(5) == 200


def test_session_xp_formula():
    # score 10, 별 3 → min(70,150)+50 = 120
    assert session_xp(10, 3) == 120
    # cap 확인: score 100 → min(250,150)=150, 별2 +20 = 170
    assert session_xp(100, 2) == 170
    # 별 없음
    assert session_xp(5, 1) == 60


def test_compute_stars():
    # balloon [5,10]
    assert compute_stars("game_balloon", 3) == 1
    assert compute_stars("game_balloon", 5) == 2
    assert compute_stars("game_balloon", 10) == 3
    # crane [3,5]
    assert compute_stars("game_crane", 2) == 1
    assert compute_stars("game_crane", 3) == 2
    assert compute_stars("game_crane", 5) == 3
    # rhythm [14,20]
    assert compute_stars("game_rhythm", 13) == 1
    assert compute_stars("game_rhythm", 14) == 2
    assert compute_stars("game_rhythm", 20) == 3
    # glide [15,24]
    assert compute_stars("game_glide", 14) == 1
    assert compute_stars("game_glide", 15) == 2
    assert compute_stars("game_glide", 24) == 3
    # 비게임 → 1
    assert compute_stars("pinch_hold", 100) == 1


def test_tier_for_level():
    assert tier_for_level(1) == "beginner"
    assert tier_for_level(10) == "beginner"
    assert tier_for_level(11) == "novice"
    assert tier_for_level(21) == "apprentice"
    assert tier_for_level(41) == "skilled"
    assert tier_for_level(61) == "expert"
    assert tier_for_level(100) == "master"
