"""Session input provenance. Stored force values remain normalized percentages."""
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, AwareDatetime, Field, model_validator

from .base import CamelModel

InputSource = Literal["ble", "websocket", "simulation", "unknown"]
SourceFilter = Literal["all", "real", "simulation", "unknown"]
Difficulty = Literal["easy", "medium", "hard"]
Hand = Literal["left", "right", "both"]
ForcePercent = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]


def _uuid_string(value: str) -> str:
    return str(UUID(value))


UUIDString = Annotated[str, AfterValidator(_uuid_string)]


class CalibrationSnapshot(CamelModel):
    version: Literal[2]
    source: Literal["ble"]
    unit: Literal["adc_12bit"]
    channel: Literal["fsr"]
    baseline0: float = Field(ge=0, le=4095, allow_inf_nan=False)
    baseline100: float = Field(ge=0, le=4095, allow_inf_nan=False)
    captured_at: AwareDatetime

    @model_validator(mode="after")
    def validate_span(self):
        # Divider polarity may be either direction; do not reject decreasing ADC.
        if abs(self.baseline100 - self.baseline0) < 64:
            raise ValueError("BLE 보정 범위는 ADC 64 이상이어야 합니다.")
        return self


def normalize_difficulty(value):
    """Only the documented legacy normal spelling is accepted as an alias."""
    return "medium" if value == "normal" else value
