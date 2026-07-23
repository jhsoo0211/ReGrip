"""합성 DB2 .mat 생성기 (테스트/개발용, scipy.io.savemat).

★ 실 probe 로 확정된 형식에 맞춘다(예전엔 "파일별 1부터 재시작"이라는 틀린 가정을 인코딩했다):
  - restimulus 는 **전역 코드**다. B=1-17, C=18-40, D=41-49, rest=0. 오프셋 재시작이 아니다.
  - E1/E2(exercise 1/2)엔 `inclin`, E3(exercise 3)엔 `activation` 키가 있다(로더 미지키 경로 검증용).
  - E3 는 glove 가 **없고** force(N,6)+forcecal(2,6) 이 **있다**. E1/E2 는 glove 있음, force 없음.
  - label_short_by>0 이면 신호보다 restimulus/rerepetition 을 그만큼 짧게 만들어
    실 E3 의 길이 어긋남(신호 877073 vs 라벨 877072)을 재현한다.
시드 고정으로 결정론적.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import scipy.io

# exercise → 해당 block 의 전역 코드 base. 동작 m(1..n_movements) → 전역 코드 base+m.
#   1(B): base 0  → 1..17,  2(C): base 17 → 18..40,  3(D): base 40 → 41..49.
_CODE_BASE = {1: 0, 2: 17, 3: 40}
_MAX_MOVEMENTS = {1: 17, 2: 23, 3: 9}


def make_synthetic(
    path,
    *,
    subject: int,
    exercise: int,
    n_movements: int,
    reps: int,
    fs: int = 2000,
    seg_sec: float = 0.05,
    rest_sec: float = 0.03,
    label_short_by: int = 0,
) -> Path:
    """합성 DB2 .mat 를 path 에 생성하고 경로를 반환.

    exercise 1/2 → glove+inclin(force 없음), exercise 3 → activation+force+forcecal(glove 없음).
    restimulus 는 전역 코드로 채운다. label_short_by 로 신호>라벨 길이 어긋남을 재현할 수 있다.
    """
    path = Path(path)
    if exercise not in (1, 2, 3):
        raise ValueError(f"exercise must be 1/2/3, got {exercise}")
    if not (1 <= n_movements <= _MAX_MOVEMENTS[exercise]):
        raise ValueError(
            f"exercise {exercise} allows 1..{_MAX_MOVEMENTS[exercise]} movements, got {n_movements}"
        )

    seg_n = int(round(seg_sec * fs))
    rest_n = int(round(rest_sec * fs))
    if seg_n <= 0 or rest_n <= 0:
        raise ValueError("seg_sec/rest_sec too small for fs")
    if label_short_by < 0 or label_short_by >= rest_n:
        raise ValueError("label_short_by must be in [0, rest_n)")

    code_base = _CODE_BASE[exercise]

    # 결정론 시드: subject·exercise 로 고정.
    rng = np.random.default_rng(1000 * subject + exercise)

    restim_parts: list[np.ndarray] = [np.zeros(rest_n, dtype=np.int64)]  # 시작 rest
    rerep_parts: list[np.ndarray] = [np.zeros(rest_n, dtype=np.int64)]
    for rep in range(1, reps + 1):
        for mov in range(1, n_movements + 1):
            code = code_base + mov  # ★ 전역 코드
            restim_parts.append(np.full(seg_n, code, dtype=np.int64))
            rerep_parts.append(np.full(seg_n, rep, dtype=np.int64))
            restim_parts.append(np.zeros(rest_n, dtype=np.int64))  # 동작 뒤 rest
            rerep_parts.append(np.zeros(rest_n, dtype=np.int64))

    restimulus = np.concatenate(restim_parts)
    rerepetition = np.concatenate(rerep_parts)
    n = restimulus.shape[0]  # 신호 길이(전체)

    emg = (rng.standard_normal((n, 12)) * 0.1).astype(np.float32)
    acc = (rng.standard_normal((n, 36))).astype(np.float32)

    # (B4) 신호는 길이 n, 라벨은 n-label_short_by 로 짧게(끝부분 rest 를 잘라냄 → 코드 유효 유지).
    n_label = n - label_short_by
    restimulus = restimulus[:n_label]
    rerepetition = rerepetition[:n_label]

    mdict = {
        "subject": np.array([[subject]], dtype=np.int16),
        "exercise": np.array([[exercise]], dtype=np.int16),
        "emg": emg,
        "acc": acc,
        "stimulus": restimulus.reshape(-1, 1),  # 합성: stimulus == restimulus
        "restimulus": restimulus.reshape(-1, 1),
        "repetition": rerepetition.reshape(-1, 1),
        "rerepetition": rerepetition.reshape(-1, 1),
    }

    if exercise == 3:
        # E3: glove 없음, activation + force + forcecal 있음.
        mdict["activation"] = np.zeros((n, 1), dtype=np.int16)  # 더미(로더 미지키 경로 검증용)
        force = (rng.standard_normal((n, 6))).astype(np.float32)
        # forcecal row0=min, row1=max (채널별 min<max 보장: 랜덤 정규분포).
        forcecal = np.vstack([force.min(axis=0), force.max(axis=0)]).astype(np.float64)
        mdict["force"] = force
        mdict["forcecal"] = forcecal
    else:
        # E1/E2: glove 있음, inclin 더미 있음(로더 미지키 경로 검증용), force 없음.
        mdict["glove"] = (rng.standard_normal((n, 22))).astype(np.float32)
        mdict["inclin"] = np.zeros((n, 2), dtype=np.float32)  # 더미

    path.parent.mkdir(parents=True, exist_ok=True)
    scipy.io.savemat(str(path), mdict)
    return path
