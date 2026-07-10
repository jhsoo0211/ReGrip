"""통계 라우터 (02-api-spec §5.1). streak/총계 + N일 차트."""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from ..core.db import get_db
from ..models import Session as SessionModel, User, UserStats
from ..schemas.stats import ChartPoint, StatsOut
from .deps import get_current_user

router = APIRouter(prefix="/users/me", tags=["stats"])


def _parse_range_days(range_str: str) -> int:
    try:
        if range_str.endswith("d"):
            return max(1, min(365, int(range_str[:-1])))
    except (ValueError, AttributeError):
        pass
    return 7


@router.get("/stats", response_model=StatsOut)
def get_stats(
    user: User = Depends(get_current_user),
    db=Depends(get_db),
    range_: str = Query(default="7d", alias="range"),
):
    stats = db.get(UserStats, user.id)
    if stats is None:
        stats = UserStats(user_id=user.id)
        db.add(stats)
        db.commit()

    days = _parse_range_days(range_)
    today = datetime.now(timezone.utc).date()
    range_start = today - timedelta(days=days - 1)
    start_dt = datetime.combine(range_start, time.min)

    rows = db.execute(
        select(SessionModel.started_at, SessionModel.avg_force).where(
            SessionModel.user_id == user.id, SessionModel.started_at >= start_dt
        )
    ).all()

    # 날짜별 집계
    buckets: dict[str, list[float]] = {}
    for started_at, avg_force in rows:
        d = started_at.date().isoformat()
        buckets.setdefault(d, []).append(float(avg_force))

    chart: list[ChartPoint] = []
    for i in range(days):
        d = (range_start + timedelta(days=i)).isoformat()
        forces = buckets.get(d, [])
        chart.append(
            ChartPoint(
                date=d,
                sessions=len(forces),
                avg_force=round(sum(forces) / len(forces), 2) if forces else None,
            )
        )

    return StatsOut(
        total_xp=stats.total_xp,
        level=stats.level,
        tier=stats.tier,
        current_streak=stats.current_streak,
        longest_streak=stats.longest_streak,
        total_sessions=stats.total_sessions,
        best_max_force=float(stats.best_max_force) if stats.best_max_force is not None else None,
        chart=chart,
    )
