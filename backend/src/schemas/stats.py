"""통계 / xp-events 스키마 (02-api-spec §5.1, §5.3)."""
from __future__ import annotations

from .base import CamelModel
from .provenance import SourceFilter


class SourceCounts(CamelModel):
    real: int = 0
    simulation: int = 0
    unknown: int = 0


class ChartPoint(CamelModel):
    date: str  # YYYY-MM-DD
    sessions: int
    avg_force: float | None = None


class StatsOut(CamelModel):
    total_xp: int
    level: int
    tier: str
    current_streak: int
    longest_streak: int
    total_sessions: int
    best_max_force: float | None = None
    chart: list[ChartPoint] = []
    source: SourceFilter = "all"
    all_session_count: int
    source_counts: SourceCounts


class XpEventOut(CamelModel):
    amount: int
    reason: str
    ref_type: str | None = None
    ref_id: str | None = None
    created_at: str  # ISO UTC 'Z'


class XpEventListResponse(CamelModel):
    data: list[XpEventOut]
