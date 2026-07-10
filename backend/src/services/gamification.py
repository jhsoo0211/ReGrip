"""서버 권위 게이미피케이션 계산 (03-gamification-engine.md, 프론트 shared.js 와 동일 상수).

순수 함수만 둔다(트랜잭션은 session_service.py). 프론트 GamificationEngine 과 값이 일치해야
totalXp 불변식(= Σ xp_events)이 양쪽에서 성립한다.
"""
from __future__ import annotations

from .labels import STAR_THRESHOLDS

# XP 상수 (프론트 XP_RULES 와 동일)
SESSION_BASE = 50
PER_SCORE_UNIT = 2
SESSION_CAP = 150
TWO_STAR_BONUS = 20
THREE_STAR_BONUS = 50
STREAK7_BONUS = 200

# 6티어 경계 (03 §3): (code, min_level, max_level)
TIERS: list[tuple[str, int, int]] = [
    ("beginner", 1, 10),
    ("novice", 11, 20),
    ("apprentice", 21, 40),
    ("skilled", 41, 60),
    ("expert", 61, 80),
    ("master", 81, 100),
]


def compute_stars(exercise_type: str, score: int) -> int:
    """게임별 별점 재계산 (03 §4). 클라 값 무시. 비게임은 1."""
    th = STAR_THRESHOLDS.get(exercise_type)
    if not th:
        return 1
    t2, t3 = th
    if score >= t3:
        return 3
    if score >= t2:
        return 2
    return 1


def session_xp(score: int, stars: int) -> int:
    """세션 XP = min(50 + score*2, 150) + 별 보너스(별3 +50 / 별2 +20). 보너스는 cap 이후 가산."""
    base = min(SESSION_BASE + score * PER_SCORE_UNIT, SESSION_CAP)
    bonus = THREE_STAR_BONUS if stars == 3 else TWO_STAR_BONUS if stars == 2 else 0
    return base + bonus


def xp_to_next(level: int) -> int:
    """level → level+1 에 필요한 XP (03 §2)."""
    return 100 + (max(1, level) - 1) * 25


def level_from_xp(total_xp: int) -> int:
    """누적 XP → 레벨 (1~100 클램프). 프론트 levelFromXp 와 동일 로직."""
    total_xp = max(0, int(total_xp))
    level = 1
    remaining = total_xp
    while level < 100:
        need = xp_to_next(level)
        if remaining >= need:
            remaining -= need
            level += 1
        else:
            break
    return level


def tier_for_level(level: int) -> str:
    for code, mn, mx in TIERS:
        if mn <= level <= mx:
            return code
    return "beginner" if level < 1 else "master"
