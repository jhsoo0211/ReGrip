"""캘리브레이션 스키마 (02-api-spec §5.4).

필드명은 모델 속성(baseline_raw_0/baseline_raw_100)과 일치시켜 from_attributes 매핑이 되게 하고,
to_camel alias 로 API 는 baselineRaw0/baselineRaw100 을 노출한다(02 계약).
"""
from __future__ import annotations

from .base import CamelModel


class CalibrationCreate(CamelModel):
    device_id: str | None = None
    baseline_raw_0: float
    baseline_raw_100: float


class CalibrationOut(CamelModel):
    id: int
    device_id: str | None = None
    baseline_raw_0: float
    baseline_raw_100: float
    calibrated_at: str  # ISO UTC 'Z'
