"""캘리브레이션 라우터 (02-api-spec §5.4). 이력 append + 최신 1건 조회."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from ..core.db import get_db
from ..core.errors import AppError
from ..core.timeutil import iso_z
from ..models import Calibration, Device, User
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
    if body.device_id is not None:
        device = db.get(Device, body.device_id)
        if device is None or device.owner_user_id != user.id:
            raise AppError(422, "VALIDATION_FAILED", "사용자에게 등록된 기기가 아닙니다.", {"field": "deviceId"})
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


@router.get(
    "/calibrations/latest",
    response_model=CalibrationOut,
    responses={204: {"description": "캘리브레이션 이력 없음(정상 상태)"}},
)
def latest_calibration(user: User = Depends(get_current_user), db=Depends(get_db)):
    """최신 캘리브레이션 1건.

    이력이 없는 것은 **오류가 아니라 정상 초기 상태**다(신규 가입자). 프론트는 이 엔드포인트를
    매 페이지 로드마다 호출하므로, 404 대신 `204 No Content` 를 돌려 브라우저 콘솔에 매번
    네트워크 오류가 찍히는 것을 피한다. 프론트는 204 를 `null` 로 해석한다.
    """
    c = db.execute(
        select(Calibration)
        .where(Calibration.user_id == user.id)
        .order_by(Calibration.calibrated_at.desc(), Calibration.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    if c is None:
        return Response(status_code=204)
    return _to_out(c)
