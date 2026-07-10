"""캘리브레이션 라우터 (02-api-spec §5.4). 이력 append + 최신 1건 조회."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select

from ..core.db import get_db
from ..core.errors import AppError
from ..core.timeutil import iso_z
from ..models import Calibration, User
from ..schemas.calibration import CalibrationCreate, CalibrationOut
from .deps import get_current_user

router = APIRouter(prefix="/users/me", tags=["calibrations"])


def _to_out(c: Calibration) -> CalibrationOut:
    return CalibrationOut(
        id=c.id,
        device_id=c.device_id,
        baseline_raw_0=c.baseline_raw_0,
        baseline_raw_100=c.baseline_raw_100,
        calibrated_at=iso_z(c.calibrated_at),
    )


@router.post("/calibrations", status_code=201, response_model=CalibrationOut)
def create_calibration(
    body: CalibrationCreate, user: User = Depends(get_current_user), db=Depends(get_db)
):
    c = Calibration(
        user_id=user.id,
        device_id=body.device_id,
        baseline_raw_0=body.baseline_raw_0,
        baseline_raw_100=body.baseline_raw_100,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return _to_out(c)


@router.get("/calibrations/latest", response_model=CalibrationOut)
def latest_calibration(user: User = Depends(get_current_user), db=Depends(get_db)):
    c = db.execute(
        select(Calibration)
        .where(Calibration.user_id == user.id)
        .order_by(Calibration.calibrated_at.desc(), Calibration.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if c is None:
        raise AppError(404, "NOT_FOUND", "캘리브레이션 이력이 없습니다.")
    return _to_out(c)
