"""세션 저장 트랜잭션 (03-gamification-engine.md §6) — 게이미피케이션 엔진의 심장.

BEGIN → user_stats FOR UPDATE(유저 단위 직렬화) → INSERT session(+sets) → xp_events(session)
→ streak 갱신(+보너스) → 업적 판정(+unlock 이벤트) → user_stats 갱신 → COMMIT.
멱등: UNIQUE(user_id, client_session_id). 중복은 200 + 최초 result_snapshot 그대로(XP 재적립 없음).
totalXp 는 Σ xp_events 로 확정해 원장 불변식을 강제한다.
"""
from __future__ import annotations

import logging
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from ..core.config import settings
from ..core.errors import AppError
from ..core.timeutil import (
    as_aware_utc,
    iso_z,
    now_naive_utc,
    resolve_zone,
    to_naive_utc,
    to_user_date,
)
from ..models import (
    AchievementDefinition,
    Device,
    Session as SessionModel,
    SessionSet,
    UserAchievement,
    UserSettings,
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

logger = logging.getLogger(__name__)

_VALID_EXERCISE_TYPES = set(EXERCISE_LABELS.keys())

# streak 재계산 시 조회하는 최근 창(일). 03 §1: 최근 90일 distinct 세션 날짜 기준.
_STREAK_WINDOW_DAYS = 90


def _user_zone(db, user_id: str) -> ZoneInfo:
    """사용자 로컬 타임존(A4). user_settings.timezone → ZoneInfo, 무효/미설정 시 기본 폴백."""
    us = db.get(UserSettings, user_id)
    return resolve_zone(us.timezone if us is not None else None)


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
        "inputSource": sess.input_source,
        "calibrationSnapshot": sess.calibration_snapshot,
    }


def _existing_result(sess: SessionModel) -> dict:
    """Add provenance to pre-v2 response snapshots without changing saved reward facts."""
    result = dict(sess.result_snapshot or {})
    if "session" in result:
        summary = dict(result["session"])
        summary.setdefault("inputSource", sess.input_source or "unknown")
        summary.setdefault("calibrationSnapshot", sess.calibration_snapshot)
        result["session"] = summary
    return result


def _find_existing(db, user_id: str, client_session_id: str) -> SessionModel | None:
    return db.execute(
        select(SessionModel).where(
            SessionModel.user_id == user_id,
            SessionModel.client_session_id == client_session_id,
        )
    ).scalar_one_or_none()


def process_session_submission(db, user, payload) -> tuple[int, dict]:
    """(status_code, body) 반환. 신규=201, 멱등 중복=200."""
    # 1) user_stats FOR UPDATE — 트랜잭션에서 가장 먼저 유저 단위 직렬화 락을 확보한다 (A3, 03 §6.2).
    #    이후 멱등 검사·일일 상한 카운트·집계가 모두 이 락 아래에서 직렬화된다 (SQLite 는 락 무시).
    stats = db.execute(
        select(UserStats).where(UserStats.user_id == user.id).with_for_update()
    ).scalar_one_or_none()
    if stats is None:
        stats = UserStats(user_id=user.id)
        db.add(stats)
        db.flush()

    # 2) 멱등 사전 조회 (락 이후) — 이미 처리된 세션이면 최초 결과 그대로 반환(검증도 건너뜀).
    existing = _find_existing(db, user.id, payload.client_session_id)
    if existing is not None:
        return 200, _existing_result(existing)

    # 3) 사용자 로컬 타임존 (A4): streak/일일상한 달력일의 기준.
    zone = _user_zone(db, user.id)

    # 4) 도메인 검증 (422). 스키마가 0..100, duration>0 은 이미 보장.
    if payload.exercise_type not in _VALID_EXERCISE_TYPES:
        raise AppError(
            422, "VALIDATION_FAILED", "알 수 없는 exerciseType 입니다.", {"field": "exerciseType"}
        )
    if payload.max_force < payload.avg_force:
        raise AppError(
            422, "VALIDATION_FAILED", "avgForce must be <= maxForce", {"field": "avgForce"}
        )
    try:
        started_aware = as_aware_utc(payload.started_at)
    except (OverflowError, ValueError):
        raise AppError(
            422, "VALIDATION_FAILED", "startedAt이 유효한 UTC 날짜 범위를 벗어났습니다.",
            {"field": "startedAt"},
        )
    now_aware = datetime.now(timezone.utc)
    if started_aware > now_aware + timedelta(seconds=settings.started_at_skew_sec):
        raise AppError(
            422, "VALIDATION_FAILED", "startedAt must not be in the future", {"field": "startedAt"}
        )
    # 백데이트 하한 (A1): 오프라인 큐 재전송 허용폭(BACKDATE_LIMIT_HOURS)을 넘는 과거는 거부.
    if started_aware < now_aware - timedelta(hours=settings.backdate_limit_hours):
        raise AppError(
            422,
            "VALIDATION_FAILED",
            f"startedAt이 허용 범위({settings.backdate_limit_hours}시간)를 벗어났습니다",
            {"field": "startedAt"},
        )
    # deviceId 존재 선검증 (C2): FK 위반(운영 PG 500)에 앞서 422 로 명확히 거부한다.
    if payload.device_id is not None:
        device = db.get(Device, payload.device_id)
        if device is None or device.owner_user_id != user.id:
            raise AppError(
                422, "VALIDATION_FAILED", "사용자에게 등록된 기기가 아닙니다.", {"field": "deviceId"}
            )

    # 5) 일일 세션 상한 (422) — '주장된 startedAt' 이 아니라 **서버 수신 시각(created_at)** 기준의
    #    사용자 로컬 '오늘' 로 센다 (A2). 백데이트를 여러 날짜로 분산해도 수신일이 같으면 상한에 걸린다.
    today_user = datetime.now(zone).date()
    day_start_utc = to_naive_utc(datetime.combine(today_user, time.min, tzinfo=zone))
    day_end_utc = to_naive_utc(
        datetime.combine(today_user + timedelta(days=1), time.min, tzinfo=zone)
    )
    day_count = db.execute(
        select(func.count())
        .select_from(SessionModel)
        .where(
            SessionModel.user_id == user.id,
            SessionModel.created_at >= day_start_utc,
            SessionModel.created_at < day_end_utc,
        )
    ).scalar_one()
    if day_count >= settings.max_daily_sessions:
        raise AppError(
            422,
            "VALIDATION_FAILED",
            f"daily session limit ({settings.max_daily_sessions}) exceeded",
            {"field": "startedAt"},
        )

    started_db = to_naive_utc(payload.started_at)  # naive UTC 저장
    old_level = stats.level

    # 6) 세션 INSERT (stars 서버 재계산)
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
        input_source=payload.input_source,
        calibration_snapshot=(payload.calibration_snapshot.model_dump(mode="json", by_alias=True)
                              if payload.calibration_snapshot is not None else None),
    )
    db.add(sess)
    try:
        db.flush()
    except IntegrityError as exc:
        # 예상되는 위반은 멱등키 uq_sessions_idem(동시 재제출) 뿐이다. deviceId 는 위에서
        # 선검증했고 중복 setIndex 는 스키마에서 걸러졌다. 롤백 후 최초 결과가 있으면 멱등 200,
        # 없으면 uq 외의 예상 밖 위반이므로 삼키지 말고 로깅 후 재raise(→500) 한다 (C2).
        db.rollback()
        existing = _find_existing(db, user.id, payload.client_session_id)
        if existing is not None:
            return 200, _existing_result(existing)
        logger.warning("세션 INSERT 중 예상치 못한 IntegrityError: %s", exc)
        raise

    # 7) session_sets (optional) — 중복 setIndex 는 스키마 검증에서 이미 422 처리 (C1)
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

    # 8) 세션 XP 원장
    sxp = session_xp(payload.score, stars)
    db.add(
        XpEvent(user_id=user.id, amount=sxp, reason="session", ref_type="session", ref_id=sess.id)
    )

    # 9) streak 순서무관 재계산 (+7일 보너스 1회/run) — B1/B2
    streak_bonus = _recompute_streak(db, user.id, stats, zone, today_user)

    # 10) 집계 갱신
    stats.total_sessions += 1
    mf = float(payload.max_force)
    stats.best_max_force = mf if stats.best_max_force is None else max(float(stats.best_max_force), mf)

    db.flush()

    # 11) 업적 판정 (이번 세션 포함 전체 재평가) — 재계산된 current_streak 사용
    unlocked, achievement_xp = _evaluate_achievements(db, user.id, stats.current_streak)

    db.flush()

    # 12) totalXp = Σ xp_events (원장 불변식), level/tier 유도
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


def _run_length(dates: set) -> int:
    """distinct 날짜 집합에서 '가장 최근 세션일에 끝나는 연속 run' 의 길이(순서 무관).

    프론트 shared.js computeStreak 의미론(연속 run 길이)과 일치한다. 앵커는 max(dates)로,
    역순/무작위 순서로 제출되어도 같은 집합이면 같은 값이 나온다.
    """
    if not dates:
        return 0
    cursor = max(dates)
    n = 0
    while cursor in dates:
        n += 1
        cursor -= timedelta(days=1)
    return n


def _recompute_streak(db, user_id: str, stats: UserStats, zone, today_user) -> int:
    """순서무관 streak 재계산 (B1) + 7일 보너스 run 당 1회 (B2). 반환: 이번 보너스 XP.

    방금 INSERT 된 세션을 포함해, 사용자 TZ 기준 최근 90일 distinct 세션 날짜로 current_streak 를
    재계산한다. 오프라인 역순 재전송(예: 07-01~07 역순 제출)이어도 최종 집합이 연속 7일이면 streak=7.
    """
    cutoff_date = today_user - timedelta(days=_STREAK_WINDOW_DAYS)
    cutoff_utc = to_naive_utc(datetime.combine(cutoff_date, time.min, tzinfo=zone))
    rows = db.execute(
        select(SessionModel.started_at).where(
            SessionModel.user_id == user_id,
            SessionModel.started_at >= cutoff_utc,
        )
    ).all()
    dates = {to_user_date(r[0], zone) for r in rows}

    current = _run_length(dates)
    stats.current_streak = current
    if dates:
        newest = max(dates)
        # 과거 백필로는 last_session_date 를 되돌리지 않는다(최신값 유지).
        if stats.last_session_date is None or newest > stats.last_session_date:
            stats.last_session_date = newest
    stats.longest_streak = max(stats.longest_streak, current)

    # 7일 연속 보너스(+200): run 당 1회. run 이 끊기면(<7) 플래그를 리셋해 다음 run 을 대비 (B2).
    streak_bonus = 0
    if current >= 7 and not stats.streak_bonus_awarded_for_run:
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
    elif current < 7:
        stats.streak_bonus_awarded_for_run = False

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
