"""signal_offsets 순수 stdlib 산술 검증 (scipy 불필요).

이 테스트는 src.services.signal_offsets(레이트 변환·라벨 오프셋 단일 출처)만 쓴다.
numpy/scipy 를 임포트하지 않는다 — src/ 의존성 격리를 이 레벨에서도 지킨다.
"""
from __future__ import annotations

import pytest

from src.services.signal_offsets import (
    NATIVE_RATES_DB2,
    STORED_RATE_DB2,
    block_code_range,
    resample_ratio,
    validate_label_code,
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


@pytest.mark.parametrize("block,expected", [("B", (1, 17)), ("C", (18, 40)), ("D", (41, 49))])
def test_block_code_range(block, expected):
    assert block_code_range(block) == expected


def test_block_code_range_A_raises():
    # A 는 DB2 프로토콜에 없다 → 사용 시 ValueError.
    with pytest.raises(ValueError):
        block_code_range("A")


@pytest.mark.parametrize(
    "block,code",
    [("B", 1), ("B", 17), ("C", 18), ("C", 40), ("D", 41), ("D", 49)],
)
def test_validate_label_code_returns_value_unchanged(block, code):
    # ★ restimulus 는 이미 전역 코드다 → 오프셋 없이 그대로 반환.
    assert validate_label_code(code, block) == code


def test_validate_label_code_rest_is_zero_for_all_blocks():
    for block in ("B", "C", "D"):
        assert validate_label_code(0, block) == 0


def test_validate_label_code_no_offset_added():
    # 예전 오프셋 버그 재발 방지: C 18 은 35(=18+17) 가 아니라 18, D 41 은 81(=41+40) 이 아니라 41.
    assert validate_label_code(18, "C") == 18
    assert validate_label_code(41, "D") == 41


@pytest.mark.parametrize(
    "block,code",
    [("B", 18), ("C", 17), ("C", 41), ("D", 40), ("B", 50), ("D", 18)],
)
def test_validate_label_code_rejects_out_of_range(block, code):
    # block 범위를 벗어난 코드는 조용한 오라벨 대신 ValueError 로 막는다.
    with pytest.raises(ValueError):
        validate_label_code(code, block)
