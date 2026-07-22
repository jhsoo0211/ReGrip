"""signal_offsets 순수 stdlib 산술 검증 (scipy 불필요).

이 테스트는 src.services.signal_offsets(레이트 변환·라벨 오프셋 단일 출처)만 쓴다.
numpy/scipy 를 임포트하지 않는다 — src/ 의존성 격리를 이 레벨에서도 지킨다.
"""
from __future__ import annotations

import pytest

from src.services.signal_offsets import (
    NATIVE_RATES_DB2,
    STORED_RATE_DB2,
    label_offset,
    resample_ratio,
)


def test_native_rates_constants():
    assert NATIVE_RATES_DB2 == {"emg": 2000, "acc": 148, "glove": 25, "force": 100}
    assert STORED_RATE_DB2 == 2000


@pytest.mark.parametrize(
    "source,target,expected",
    [
        (2000, 148, (37, 500)),
        (2000, 25, (1, 80)),
        (2000, 100, (1, 20)),
        (2000, 2000, (1, 1)),
    ],
)
def test_resample_ratio(source, target, expected):
    assert resample_ratio(source, target) == expected


def test_resample_ratio_rejects_nonpositive():
    with pytest.raises(ValueError):
        resample_ratio(0, 100)
    with pytest.raises(ValueError):
        resample_ratio(2000, -1)


@pytest.mark.parametrize("block,expected", [("B", 0), ("C", 17), ("D", 40)])
def test_label_offset(block, expected):
    assert label_offset(block) == expected


def test_label_offset_A_raises():
    # A 는 DB2 프로토콜에 없다 → 사용 시 ValueError.
    with pytest.raises(ValueError):
        label_offset("A")
