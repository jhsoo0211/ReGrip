"""업적 6종 시드 + rule_type 별 판정 evaluator (03 §5, 프론트 GamificationEngine.ACHIEVEMENTS).

프론트 6종과 동일 id/타이틀/XP. 판정은 하이브리드 룰: rule_type 은 코드, 임계값은 rule_params(jsonb).
01 DDL 의 rule_type enum(session_count/max_force_gte/streak_days/total_sets)만 사용하고,
프론트의 게임 필터/별점 조건은 rule_params 확장 파라미터로 인코딩한다.

rule_params 확장 파라미터:
  - exercise_type : 특정 게임만 카운트 (예: 'game_balloon')
  - min_sets      : set_count >= min_sets 인 세션만 카운트
  - min_stars     : stars >= min_stars 인 세션만 카운트
  - count         : session_count/max_force_gte 목표 개수
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SessionFacts:
    exercise_type: str
    set_count: int
    stars: int
    max_force: float


@dataclass
class AchievementContext:
    sessions: list[SessionFacts]
    current_streak: int


# 프론트 GamificationEngine.ACHIEVEMENTS 와 동일한 6종.
# category/rarity 는 enum 코드로 매핑 (게임 플레이→game_play, 악력 훈련→grip_training,
# 지속성→persistence, 수집→collection / 일반→common, 희귀→rare, 에픽→epic, 전설→legendary).
ACHIEVEMENT_SEEDS: list[dict] = [
    {
        "id": "first_pop",
        "title": "첫 풍선",
        "description": "풍선 게임에서 첫 세트를 완료했습니다.",
        "category": "game_play",
        "rarity": "common",
        "reward_xp": 100,
        "rule_type": "session_count",
        "rule_params": {"count": 1, "exercise_type": "game_balloon", "min_sets": 1},
        "sort_order": 10,
    },
    {
        "id": "first_capsule",
        "title": "첫 번째 캡슐",
        "description": "크레인 게임에서 첫 캡슐을 수집했습니다.",
        "category": "game_play",
        "rarity": "common",
        "reward_xp": 100,
        "rule_type": "session_count",
        "rule_params": {"count": 1, "exercise_type": "game_crane", "min_sets": 1},
        "sort_order": 20,
    },
    {
        "id": "three_star",
        "title": "퍼펙트 훈련",
        "description": "한 세션에서 별 3개를 획득했습니다.",
        "category": "game_play",
        "rarity": "common",
        "reward_xp": 150,
        "rule_type": "session_count",
        "rule_params": {"count": 1, "min_stars": 3},
        "sort_order": 30,
    },
    {
        "id": "strong_grip",
        "title": "강철 악력",
        "description": "최대 악력 80% 이상을 5회 달성했습니다.",
        "category": "grip_training",
        "rarity": "rare",
        "reward_xp": 200,
        "rule_type": "max_force_gte",
        "rule_params": {"threshold": 80, "count": 5},
        "sort_order": 40,
    },
    {
        "id": "consistency_king",
        "title": "꾸준함의 왕",
        "description": "7일 연속으로 훈련했습니다.",
        "category": "persistence",
        "rarity": "epic",
        "reward_xp": 300,
        "rule_type": "streak_days",
        "rule_params": {"days": 7},
        "sort_order": 50,
    },
    {
        "id": "halfway_goal",
        "title": "캡슐 수집가",
        "description": "크레인 게임에서 누적 캡슐 500개를 수집했습니다.",
        "category": "collection",
        "rarity": "legendary",
        "reward_xp": 500,
        "rule_type": "total_sets",
        "rule_params": {"sets": 500, "exercise_type": "game_crane"},
        "sort_order": 60,
    },
]


def _match(s: SessionFacts, params: dict) -> bool:
    et = params.get("exercise_type")
    if et is not None and s.exercise_type != et:
        return False
    min_sets = params.get("min_sets")
    if min_sets is not None and s.set_count < min_sets:
        return False
    min_stars = params.get("min_stars")
    if min_stars is not None and s.stars < min_stars:
        return False
    return True


def evaluate(rule_type: str, rule_params: dict, ctx: AchievementContext) -> tuple[int, int]:
    """(progress, target) 를 반환. progress >= target 이면 달성."""
    params = rule_params or {}

    if rule_type == "session_count":
        target = int(params.get("count", 1))
        progress = sum(1 for s in ctx.sessions if _match(s, params))
        return progress, target

    if rule_type == "max_force_gte":
        threshold = float(params.get("threshold", 0))
        target = int(params.get("count", 1))
        progress = sum(1 for s in ctx.sessions if s.max_force >= threshold)
        return progress, target

    if rule_type == "streak_days":
        target = int(params.get("days", 7))
        progress = ctx.current_streak
        return progress, target

    if rule_type == "total_sets":
        target = int(params.get("sets", 0))
        progress = sum(s.set_count for s in ctx.sessions if _match(s, params))
        return progress, target

    return 0, 1


def seed_achievements(db) -> int:
    """업적 정의 6종을 upsert. 앱 startup 과 seed 스크립트가 공유한다. 반환: upsert 건수."""
    from ..models import AchievementDefinition

    n = 0
    for seed in ACHIEVEMENT_SEEDS:
        row = db.get(AchievementDefinition, seed["id"])
        if row is None:
            row = AchievementDefinition(id=seed["id"])
            db.add(row)
        row.title = seed["title"]
        row.description = seed["description"]
        row.category = seed["category"]
        row.rarity = seed["rarity"]
        row.reward_xp = seed["reward_xp"]
        row.rule_type = seed["rule_type"]
        row.rule_params = seed["rule_params"]
        row.is_active = True
        row.sort_order = seed["sort_order"]
        n += 1
    db.commit()
    return n
