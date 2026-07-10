"""세션 저장 트랜잭션 (03-gamification-engine.md §6) — 게이미피케이션 엔진의 심장.

BEGIN → user_stats FOR UPDATE(유저 단위 직렬화) → INSERT session(+sets) → xp_events(session)
→ streak 갱신(+보너스) → 업적 판정(+unlock 이벤트) → user_stats 갱신 → COMMIT.
멱등: UNIQUE(user_id, client_session_id). 중복은 200 + 최초 result_snapshot 그대로(XP 재적립 없음).
totalXp 는 Σ xp_events 로 확정해 원장 불변식을 강제한다.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..core.config import settings
from ..core.errors import AppError
from ..core.timeutil import as_aware_utc, iso_z, now_naive_utc, to_naive_utc
from ..models import (
    AchievementDefinition,
    Session as SessionModel,
    SessionSet,
    UserAchievement,
    UserStats,
    XpEvent,
)
from .achievements import AchievementContext, SessionFacts, evaluate
from .gamification import (
    STREAK7_BONUS,
    compute_stars,
    level_from_xp,
    session_xp,
    tier_for_level,
)
from .labels import EXERCISE_LABELS, label_for

_VALID_EXERCISE_TYPES = set(EXERCISE_LABELS.keys())


def _summary(sess: SessionModel) -> dict:
    return {
        "id": sess.id,
        "clientSessionId": sess.client_session_id,
        "date": iso_z(sess.started_at),
        "exerciseType": sess.exercise_type,
        "label": label_for(sess.exercise_type),
        "durationMin": round(sess.duration_sec / 60),
        "sets": sess.set_count,
        "avgForce": float(sess.avg_force),
        "maxForce": float(sess.max_force),
        "stars": sess.stars,
    }


def _find_existing(db, user_id: str, client_session_id: str) -> SessionModel | None:
    return db.execute(
        select(SessionModel).where(
            SessionModel.user_id == user_id,
            SessionModel.client_session_id == client_session_id,
        )
    ).scalar_one_or_none()


def process_session_submission(db, user, payload) -> tuple[int, dict]:
    """(status_code, body) 반환. 신규=201, 멱등 중복=200."""
    # 0) 멱등 사전 조회 — 이미 처리된 세션이면 최초 결과 그대로 반환(검증도 건너뜀).
    existing = _find_existing(db, user.id, payload.client_session_id)
    if existing is not None:
        return 200, (existing.result_snapshot or {})

    # 1) 도메인 검증 (422). 스키마가 0..100, duration>0 은 이미 보장.
    if payload.exercise_type not in _VALID_EXERCISE_TYPES:
        raise AppError(
            422, "VALIDATION_FAILED", "알 수 없는 exerciseType 입니다.", {"field": "exerciseType"}
        )
    if payload.max_force < payload.avg_force:
        raise AppError(
            422, "VALIDATION_FAILED", "avgForce must be <= maxForce", {"field": "avgForce"}
        )
    started_aware = as_aware_utc(payload.started_at)
    now_aware = datetime.now(timezone.utc)
    if started_aware > now_aware + timedelta(seconds=settings.started_at_skew_sec):
        raise AppError(
            422, "VALIDATION_FAILED", "startedAt must not be in the future", {"field": "startedAt"}
        )

    started_db = to_naive_utc(payload.started_at)  # naive UTC 저장
    session_date = started_db.date()

    # 일일 세션 상한 (422)
    day_start = datetime.combine(session_date, time.min)
    day_end = day_start + timedelta(days=1)
    day_count = db.execute(
        select(func.count())
        .select_from(SessionModel)
        .where(
            SessionModel.user_id == user.id,
            SessionModel.started_at >= day_start,
            SessionModel.started_at < day_end,
        )
    ).scalar_one()
    if day_count >= settings.max_daily_sessions:
        raise AppError(
            422,
            "VALIDATION_FAILED",
            f"daily session limit ({settings.max_daily_sessions}) exceeded",
            {"field": "startedAt"},
        )

    # 2) user_stats FOR UPDATE — 유저 단위 직렬화 (SQLite 는 무시됨)
    stats = db.execute(
        select(UserStats).where(UserStats.user_id == user.id).with_for_update()
    ).scalar_one_or_none()
    if stats is None:
        stats = UserStats(user_id=user.id)
        db.add(stats)
        db.flush()

    old_level = stats.level

    # 3) 세션 INSERT (stars 서버 재계산)
    stars = compute_stars(payload.exercise_type, payload.score)
    sess = SessionModel(
        client_session_id=payload.client_session_id,
        user_id=user.id,
        exercise_type=payload.exercise_type,
        started_at=started_db,
        duration_sec=payload.duration_sec,
        set_count=payload.score,
        avg_force=payload.avg_force,
        max_force=payload.max_force,
        stars=stars,
        attempts=payload.attempts,
        difficulty=payload.difficulty,
        hand_used=payload.hand_used,
        device_id=payload.device_id,
        force_series=payload.force_series,
    )
    db.add(sess)
    try:
        db.flush()
    except IntegrityError:
        # 동시 멱등 충돌: 롤백 후 최초 결과 반환 (XP 재적립 없음)
        db.rollback()
        existing = _find_existing(db, user.id, payload.client_session_id)
        if existing is not None:
            return 200, (existing.result_snapshot or {})
        raise

    # 4) session_sets (optional)
    if payload.sets:
        for st in payload.sets:
            db.add(
                SessionSet(
                    session_id=sess.id,
                    set_index=st.set_index,
                    reps=st.reps,
                    avg_force=st.avg_force,
                    peak_force=st.peak_force,
                    hold_sec=st.hold_sec,
                )
            )

    # 5) 세션 XP 원장
    sxp = session_xp(payload.score, stars)
    db.add(
        XpEvent(user_id=user.id, amount=sxp, reason="session", ref_type="session", ref_id=sess.id)
    )

    # 6) streak 갱신 (+7일 보너스 1회/run)
    streak_bonus = _update_streak(db, user.id, stats, session_date)

    # 7) 집계 갱신
    stats.total_sessions += 1
    mf = float(payload.max_force)
    stats.best_max_force = mf if stats.best_max_force is None else max(float(stats.best_max_force), mf)

    db.flush()

    # 8) 업적 판정 (이번 세션 포함 전체 재평가)
    unlocked, achievement_xp = _evaluate_achievements(db, user.id, stats.current_streak)

    db.flush()

    # 9) totalXp = Σ xp_events (원장 불변식), level/tier 유도
    total_xp = int(
        db.execute(
            select(func.coalesce(func.sum(XpEvent.amount), 0)).where(XpEvent.user_id == user.id)
        ).scalar_one()
    )
    new_level = level_from_xp(total_xp)
    stats.total_xp = total_xp
    stats.level = new_level
    stats.tier = tier_for_level(new_level)
    stats.updated_at = now_naive_utc()

    xp_awarded = sxp + streak_bonus + achievement_xp
    level_up = new_level > old_level

    body = {
        "session": _summary(sess),
        "xpAwarded": xp_awarded,
        "totalXp": total_xp,
        "level": new_level,
        "levelUp": level_up,
        "unlockedAchievements": unlocked,
    }
    sess.result_snapshot = body
    db.add(sess)
    db.commit()
    return 201, body


def _update_streak(db, user_id: str, stats: UserStats, session_date) -> int:
    """last_session_date 기반 streak 갱신. 7일 도달 시 run 당 1회 +200 지급. 반환: 이번 보너스 XP."""
    last = stats.last_session_date
    if last is None:
        stats.current_streak = 1
        stats.streak_bonus_awarded_for_run = False
    elif session_date == last:
        pass  # 같은 날 추가 세션 — streak 유지
    elif session_date == last + timedelta(days=1):
        stats.current_streak += 1
    elif session_date > last + timedelta(days=1):
        stats.current_streak = 1
        stats.streak_bonus_awarded_for_run = False
    # session_date < last (과거 백필): streak 미변경

    if last is None or session_date > last:
        stats.last_session_date = session_date

    streak_bonus = 0
    if stats.current_streak >= 7 and not stats.streak_bonus_awarded_for_run:
        streak_bonus = STREAK7_BONUS
        stats.streak_bonus_awarded_for_run = True
        db.add(
            XpEvent(
                user_id=user_id,
                amount=STREAK7_BONUS,
                reason="streak_bonus",
                ref_type="streak",
                ref_id=None,
            )
        )

    stats.longest_streak = max(stats.longest_streak, stats.current_streak)
    return streak_bonus


def load_session_facts(db, user_id: str) -> list[SessionFacts]:
    rows = db.execute(
        select(
            SessionModel.exercise_type,
            SessionModel.set_count,
            SessionModel.stars,
            SessionModel.max_force,
        ).where(SessionModel.user_id == user_id)
    ).all()
    return [
        SessionFacts(exercise_type=r[0], set_count=r[1], stars=r[2], max_force=float(r[3]))
        for r in rows
    ]


def _evaluate_achievements(db, user_id: str, current_streak: int) -> tuple[list[dict], int]:
    """활성 업적 전체 재평가. 이번에 달성된 것만 unlock 이벤트 적립. 반환: (unlocked[], 업적 XP 합)."""
    ctx = AchievementContext(
        sessions=load_session_facts(db, user_id), current_streak=current_streak
    )
    defs = (
        db.execute(
            select(AchievementDefinition)
            .where(AchievementDefinition.is_active.is_(True))
            .order_by(AchievementDefinition.sort_order)
        )
        .scalars()
        .all()
    )
    unlocked: list[dict] = []
    achievement_xp = 0
    now = now_naive_utc()
    for d in defs:
        progress, target = evaluate(d.rule_type, d.rule_params, ctx)
        ua = db.get(UserAchievement, (user_id, d.id))
        if ua is None:
            ua = UserAchievement(
                user_id=user_id, achievement_id=d.id, progress=progress, target=target
            )
            db.add(ua)
        else:
            ua.progress = progress
            ua.target = target
        if progress >= target and ua.unlocked_at is None:
            ua.unlocked_at = now
            achievement_xp += d.reward_xp
            db.add(
                XpEvent(
                    user_id=user_id,
                    amount=d.reward_xp,
                    reason="achievement",
                    ref_type="achievement",
                    ref_id=d.id,
                )
            )
            unlocked.append(
                {"id": d.id, "title": d.title, "rewardXp": d.reward_xp, "rarity": d.rarity}
            )
    return unlocked, achievement_xp
