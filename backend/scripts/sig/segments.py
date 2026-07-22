"""restimulus run-length 압축 + 겹침 가드 + 전역 라벨 코드 해소 (numpy 사용).

restimulus 는 per-sample 라벨이다. 이를 run-length 로 압축해 sig_segment 구간으로 만든다.
code_in_file 은 파일내 verbatim 값, label_id 조인용 전역 코드는 signal_offsets 오프셋으로 해소한다.
"""
from __future__ import annotations

import numpy as np

from src.services.signal_offsets import label_offset


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
    """파일내 restimulus 값 → 전역 sig_label 코드. 0(rest)은 0, 그 외는 block 오프셋 + 값."""
    code = int(code_in_file)
    if code == 0:
        return 0
    return label_offset(protocol_block) + code
