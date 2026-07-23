"""restimulus run-length 압축 + 겹침 가드 + 전역 라벨 코드 해소 (numpy 사용).

restimulus 는 per-sample 라벨이다. 이를 run-length 로 압축해 sig_segment 구간으로 만든다.
★ 실데이터 사실: DB2 restimulus 는 이미 전역 코드다. code_in_file(파일내 verbatim 값)이 곧
전역 라벨 코드이므로 오프셋을 더하지 않고 그대로 쓰되, block 허용 범위를 벗어나면 막는다
(조용한 오라벨/크래시 방지). 검증 산술은 signal_offsets.validate_label_code 가 단일 출처.
"""
from __future__ import annotations

import numpy as np

from src.services.signal_offsets import validate_label_code


def run_length(labels_1d) -> list[tuple[int, int, int]]:
    """연속 동일값 구간 리스트 [(start, end_exclusive, value), ...]. 값 변화 경계로 자른다."""
    labels = np.asarray(labels_1d).ravel()
    n = int(labels.shape[0])
    if n == 0:
        return []
    change = np.nonzero(labels[1:] != labels[:-1])[0] + 1
    starts = np.concatenate(([0], change))
    ends = np.concatenate((change, [n]))
    return [(int(s), int(e), int(labels[s])) for s, e in zip(starts, ends)]


def assert_no_overlap(segs) -> None:
    """[(start, end_exclusive, value), ...] 가 반개구간 [start,end) 로 겹치지 않는지 검사.

    run_length 출력은 구조상 안 겹치지만, manual/다중 source 대비 가드. 겹치면 ValueError.
    """
    ordered = sorted(segs, key=lambda x: x[0])
    prev_end: int | None = None
    for seg in ordered:
        start, end = int(seg[0]), int(seg[1])
        if end <= start:
            raise ValueError(f"non-positive segment length: [{start}, {end})")
        if prev_end is not None and start < prev_end:
            raise ValueError(f"overlapping segments near sample {start} (prev end {prev_end})")
        prev_end = end


def resolve_label_code(code_in_file, protocol_block: str) -> int:
    """파일내 restimulus 값 → 전역 sig_label 코드.

    DB2 restimulus 는 이미 전역 코드이므로 오프셋 없이 값을 그대로 반환한다(0=rest, 예: C 18→18,
    D 41→41). block 인자는 허용 범위 검증(provenance)에 쓰며, 범위를 벗어나면 ValueError.
    """
    return validate_label_code(code_in_file, protocol_block)
