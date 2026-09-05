"""캘리브레이션 스키마 (02-api-spec §5.4).

필드명은 모델 속성(baseline_raw_0/baseline_raw_100)과 일치시켜 from_attributes 매핑이 되게 하고,
to_camel alias 로 API 는 baselineRaw0/baselineRaw100 을 노출한다(02 계약).
"""
from __future__ import annotations

from pydantic import Field, model_validator

from .base import CamelModel
from .provenance import UUIDString


class CalibrationCreate(CamelModel):
    device_id: UUIDString | None = None
    baseline_raw_0: float = Field(allow_inf_nan=False)
    baseline_raw_100: float = Field(allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_range(self):
        if self.baseline_raw_0 == self.baseline_raw_100:
            raise ValueError("보정 기준값의 차이는 0일 수 없습니다.")
        return self


class CalibrationOut(CamelModel):
    id: int
    device_id: str | None = None
    baseline_raw_0: float
    baseline_raw_100: float
    calibrated_at: str  # ISO UTC 'Z'
