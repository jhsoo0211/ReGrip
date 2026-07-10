"""업적 스키마 (02-api-spec §5.2)."""
from __future__ import annotations

from .base import CamelModel


class AchievementDefOut(CamelModel):
    id: str
    title: str
    description: str
    category: str
    rarity: str
    reward_xp: int
    sort_order: int


class UserAchievementOut(CamelModel):
    id: str
    title: str
    description: str
    category: str
    rarity: str
    reward_xp: int
    progress: int
    target: int
    progress_label: str
    unlocked_at: str | None = None  # ISO UTC 'Z'


class AchievementDefListResponse(CamelModel):
    data: list[AchievementDefOut]


class UserAchievementListResponse(CamelModel):
    data: list[UserAchievementOut]
