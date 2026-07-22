"""결정론 리샘플 + preproc spec 해시 (scipy 사용).

저장 레이트(2 kHz)에서 모달리티별 네이티브 레이트로 다운샘플한다(설계 확정 #1=A안).
리샘플 방식(up/down/scipy_version 등)을 spec 으로 남기고 그 해시를 blob 에 기록해
재현 가능성을 보장한다. 비율 산술은 src.services.signal_offsets(stdlib) 가 단일 출처.
"""
from __future__ import annotations

import hashlib
import json

import numpy as np
import scipy
import scipy.signal

from src.services.signal_offsets import resample_ratio


def resample_modality(arr, native_hz, stored_hz) -> tuple[np.ndarray, dict]:
    """arr(저장 레이트 stored_hz)을 native_hz 로 리샘플. 반환: (out_float32_Corder, spec).

    native==stored(예: emg 2000/2000)면 리샘플 없이 float32 캐스트만 하고 method='none'.
    아니면 up,down = resample_ratio(stored, native) 로 scipy.signal.resample_poly(axis=0).
    """
    arr = np.asarray(arr)
    if int(native_hz) == int(stored_hz):
        out = np.ascontiguousarray(arr, dtype=np.float32)
        return out, {"method": "none", "dtype": "float32"}

    up, down = resample_ratio(stored_hz, native_hz)
    out = scipy.signal.resample_poly(arr, up, down, axis=0)
    out = np.ascontiguousarray(out, dtype=np.float32)
    spec = {
        "method": "resample_poly",
        "up": up,
        "down": down,
        "axis": 0,
        "dtype": "float32",
        "scipy_version": scipy.__version__,
    }
    return out, spec


def spec_sha256(spec: dict) -> bytes:
    """spec 의 결정론 직렬화(sorted keys, 공백없음) utf-8 sha256. blob.preproc_spec_sha256 용."""
    payload = json.dumps(spec, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).digest()
