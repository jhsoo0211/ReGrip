"""Session input provenance. Stored force values remain normalized percentages."""
from typing import Annotated, Literal, Union
from uuid import UUID

from pydantic import AfterValidator, AwareDatetime, Field, StrictBool, field_validator, model_validator

from .base import CamelModel

InputSource = Literal["ble", "usb", "websocket", "simulation", "unknown"]
SENSOR_SOURCES = ("ble", "usb")  # Hardware sources; each requires a calibration snapshot.
SourceFilter = Literal["all", "real", "simulation", "unknown"]
Difficulty = Literal["easy", "medium", "hard"]
Hand = Literal["left", "right", "both"]
ForcePercent = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
AdcValue = Annotated[float, Field(ge=0, le=4095, allow_inf_nan=False)]
MIN_ADC_SPAN = 64


def _uuid_string(value: str) -> str:
    return str(UUID(value))


UUIDString = Annotated[str, AfterValidator(_uuid_string)]


class CalibrationSnapshotV2(CamelModel):
    version: Literal[2]
    source: Literal["ble"]
    unit: Literal["adc_12bit"]
    channel: Literal["fsr", "finger_mean"]
    baseline0: AdcValue
    baseline100: AdcValue
    captured_at: AwareDatetime

    @model_validator(mode="after")
    def validate_span(self):
        # Divider polarity may be either direction; do not reject decreasing ADC.
        if abs(self.baseline100 - self.baseline0) < MIN_ADC_SPAN:
            raise ValueError("BLE 보정 범위는 ADC 64 이상이어야 합니다.")
        return self


class FingerCalibration(CamelModel):
    open: AdcValue
    closed: AdcValue
    use: StrictBool

    @model_validator(mode="after")
    def validate_span(self):
        if abs(self.closed - self.open) < MIN_ADC_SPAN:
            raise ValueError("손가락 보정 범위는 ADC 64 이상이어야 합니다.")
        return self


class CalibrationSnapshotV3(CamelModel):
    """Per-finger flex calibration; fingers are thumb, index, middle, ring, little."""

    version: Literal[3]
    source: Literal["ble", "usb"]
    unit: Literal["adc_12bit"]
    channel: Literal["finger_flex"]
    fingers: list[FingerCalibration | None] = Field(min_length=5, max_length=5)
    captured_at: AwareDatetime

    @field_validator("fingers")
    @classmethod
    def validate_used_finger(cls, fingers):
        if not any(finger is not None and finger.use for finger in fingers):
            raise ValueError("사용할 손가락 보정이 최소 1개 필요합니다.")
        return fingers


CalibrationSnapshot = Annotated[
    Union[CalibrationSnapshotV2, CalibrationSnapshotV3], Field(discriminator="version")
]


def normalize_difficulty(value):
    """Only the documented legacy normal spelling is accepted as an alias."""
    return "medium" if value == "normal" else value
