"""표시 라벨 유도 + 게임 별점 임계값 (03-gamification-engine, 프론트 shared.js 와 동일).

exercise_type(enum) 은 진실, 한글 라벨은 응답 시 유도(01 결정: label 비저장).
"""
from __future__ import annotations

# exercise_type → 한글 라벨. 프론트 GAME_DEFS + LEGACY_EXERCISE_ICONS 라벨과 정렬.
EXERCISE_LABELS: dict[str, str] = {
    "game_balloon": "풍선 게임",
    "game_crane": "크레인 게임",
    "pinch_hold": "핀치 그립 훈련",
    "full_grip": "완전 그립 훈련",
    "finger_ext": "손가락 펴기",
    "lateral_grip": "측면 그립 훈련",
}

# 게임별 별점 임계값 [★2, ★3] — 프론트 GAME_DEFS.starThresholds 와 동일.
STAR_THRESHOLDS: dict[str, tuple[int, int]] = {
    "game_balloon": (5, 10),
    "game_crane": (4, 8),
}


def label_for(exercise_type: str) -> str:
    return EXERCISE_LABELS.get(exercise_type, exercise_type)
