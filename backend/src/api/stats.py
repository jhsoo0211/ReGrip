"""통계 라우터 (02-api-spec §5.1). streak/총계 + N일 차트."""
from __future__ import annotations

from datetime import datetime, time, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select

from ..core.db import get_db
from ..core.timeutil import resolve_zone, to_naive_utc, to_user_date
from ..models import Session as SessionModel, User, UserSettings, UserStats
from ..schemas.stats import ChartPoint, SourceCounts, StatsOut
from ..schemas.provenance import SourceFilter
from ..services.gamification import effective_streak
from ..services.session_sources import source_group, source_predicate
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
    source: SourceFilter = Query(default="all"),
):
    stats = db.get(UserStats, user.id)
    if stats is None:
        stats = UserStats(user_id=user.id)
        db.add(stats)
        db.commit()

    # 차트/streak 는 사용자 로컬 TZ 달력일 기준 (A4).
    us = db.get(UserSettings, user.id)
    zone = resolve_zone(us.timezone if us is not None else None)

    days = _parse_range_days(range_)
    today = datetime.now(zone).date()
    range_start = today - timedelta(days=days - 1)
    # range_start(사용자 TZ) 자정을 UTC 경계로 변환해 필터.
    start_dt = to_naive_utc(datetime.combine(range_start, time.min, tzinfo=zone))

    rows = db.execute(
        select(SessionModel.started_at, SessionModel.avg_force).where(
            SessionModel.user_id == user.id, SessionModel.started_at >= start_dt,
            source_predicate(source),
        )
    ).all()

    source_counts = {"real": 0, "simulation": 0, "unknown": 0}
    counts = db.execute(
        select(SessionModel.input_source, func.count()).where(SessionModel.user_id == user.id)
        .group_by(SessionModel.input_source)
    ).all()
    for input_source, count in counts:
        source_counts[source_group(input_source)] += count
    selected_count, best_force = db.execute(
        select(func.count(), func.max(SessionModel.max_force)).where(
            SessionModel.user_id == user.id, source_predicate(source),
        )
    ).one()

    # 날짜별 집계 (사용자 TZ 날짜로 버킷팅)
    buckets: dict[str, list[float]] = {}
    for started_at, avg_force in rows:
        d = to_user_date(started_at, zone).isoformat()
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
        # 읽기 시 감쇠(B3): 마지막 세션이 오늘/어제(사용자 TZ)가 아니면 0.
        current_streak=effective_streak(stats, today),
        longest_streak=stats.longest_streak,
        total_sessions=selected_count,
        best_max_force=float(best_force) if best_force is not None else None,
        chart=chart,
        source=source,
        all_session_count=sum(source_counts.values()),
        source_counts=SourceCounts(**source_counts),
    )
