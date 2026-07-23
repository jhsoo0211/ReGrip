"""신호 레이트 변환·라벨 오프셋 산술의 단일 출처 (stdlib only — numpy/scipy 금지).

이 모듈은 src/ 아래에 있으므로 **순수 표준 라이브러리(fractions)** 만 쓴다.
이유(설계원리): 운영 API 이미지에 numpy/scipy 가 새어들면 컨테이너가 3-5× 커진다.
레이트 변환 산술을 여기 한 곳에 두고, scripts/sig/preproc.py 가 이 비율을 소비한다
(scripts/ 아래에서만 numpy/scipy 사용).

NinaPro DB2 는 저장은 전부 2 kHz 지만 실제 정보율(native)은 모달리티마다 다르다:
  emg 2000 / acc 148 / glove 25 / force 100 Hz.
blob 은 native_rate_hz·stored_rate_hz 를 둘 다 기록하고, native 로 리샘플해 저장한다
(설계 확정 #1=A안). EMG 는 진짜 2 kHz 라 리샘플하지 않는다.
"""
from __future__ import annotations

from fractions import Fraction

# DB2 모달리티별 네이티브 정보율(Hz). 저장 레이트(stored)는 전부 2 kHz.
NATIVE_RATES_DB2: dict[str, int] = {"emg": 2000, "acc": 148, "glove": 25, "force": 100}
STORED_RATE_DB2: int = 2000

# block 별 비-rest 전역 라벨 코드 허용 범위 [lo, hi] (양끝 포함).
# ★ 실데이터 사실: DB2 restimulus 는 이미 전역 코드다(파일별 1부터 재시작이 아니다).
#   B: restimulus 1-17, C: 18-40, D: 41-49, rest=0(모든 block 공통).
#   따라서 오프셋을 더하면 안 되고(예전 버그: C 18→35 오라벨, D 41→81 크래시),
#   값을 그대로 쓰되 이 범위를 벗어나면 조용한 오라벨 대신 명확한 에러로 막는다.
#   A 는 DB2 에 없으므로 매핑을 두지 않는다(사용 시 ValueError).
_BLOCK_CODE_RANGES: dict[str, tuple[int, int]] = {"B": (1, 17), "C": (18, 40), "D": (41, 49)}


def resample_ratio(source_hz, target_hz) -> tuple[int, int]:
    """source_hz → target_hz 리샘플 비율 (up, down) 을 기약분수로 돌려준다.

    up/down = target/source. 예: (2000,148)→(37,500), (2000,25)→(1,80),
    (2000,100)→(1,20), (2000,2000)→(1,1).
    """
    src = int(source_hz)
    tgt = int(target_hz)
    if src <= 0 or tgt <= 0:
        raise ValueError(f"rates must be positive ints, got source={source_hz!r} target={target_hz!r}")
    frac = Fraction(tgt, src)
    return frac.numerator, frac.denominator


def block_code_range(protocol_block: str) -> tuple[int, int]:
    """protocol_block(B/C/D) → 해당 block 의 비-rest 전역 라벨 코드 범위 (lo, hi) (양끝 포함).

    A 는 DB2 프로토콜에 없으므로 ValueError. (스키마 CHECK 는 A 를 허용하지만 DB2 는 안 쓴다.)
    """
    try:
        return _BLOCK_CODE_RANGES[protocol_block]
    except KeyError:
        raise ValueError(
            f"no code range for protocol_block {protocol_block!r} (DB2 uses B/C/D only)"
        ) from None


def validate_label_code(code, protocol_block: str) -> int:
    """restimulus 값(이미 전역 코드)을 block 허용 범위로 검증하고 **그대로** 반환(오프셋 없음).

    rest(0)은 모든 block 공통으로 허용. 그 외 값이 block 범위를 벗어나면 ValueError 로 막는다
    (예전 오프셋 가산이 유발하던 조용한 오라벨/크래시 방지). code_in_file→전역코드 매핑의 단일 출처.
    """
    code = int(code)
    if code == 0:
        return 0
    lo, hi = block_code_range(protocol_block)
    if not (lo <= code <= hi):
        raise ValueError(
            f"restimulus {code} out of range for protocol_block {protocol_block!r} "
            f"(expected 0 or {lo}-{hi}); DB2 restimulus is already a global code"
        )
    return code
