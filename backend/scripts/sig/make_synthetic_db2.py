"""합성 DB2 .mat 생성기 (테스트/개발용, scipy.io.savemat).

실데이터가 없으므로 올바른 변수명·shape 로 작은 .mat 를 만들어 인제스트 파이프라인을
end-to-end 로 검증한다. 시드 고정으로 결정론적. restimulus 는 1..n_movements 가 reps 번,
동작 사이에 rest(0). E3(exercise 3)면 force(N,6)+forcecal(2,6) 을 추가한다.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import scipy.io


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
) -> Path:
    """합성 DB2 .mat 를 path 에 생성하고 경로를 반환. exercise 3 이면 force/forcecal 포함."""
    path = Path(path)
    if exercise not in (1, 2, 3):
        raise ValueError(f"exercise must be 1/2/3, got {exercise}")

    seg_n = int(round(seg_sec * fs))
    rest_n = int(round(rest_sec * fs))
    if seg_n <= 0 or rest_n <= 0:
        raise ValueError("seg_sec/rest_sec too small for fs")

    # 결정론 시드: subject·exercise 로 고정.
    rng = np.random.default_rng(1000 * subject + exercise)

    restim_parts: list[np.ndarray] = [np.zeros(rest_n, dtype=np.int64)]  # 시작 rest
    rerep_parts: list[np.ndarray] = [np.zeros(rest_n, dtype=np.int64)]
    for rep in range(1, reps + 1):
        for mov in range(1, n_movements + 1):
            restim_parts.append(np.full(seg_n, mov, dtype=np.int64))
            rerep_parts.append(np.full(seg_n, rep, dtype=np.int64))
            restim_parts.append(np.zeros(rest_n, dtype=np.int64))  # 동작 뒤 rest
            rerep_parts.append(np.zeros(rest_n, dtype=np.int64))

    restimulus = np.concatenate(restim_parts)
    rerepetition = np.concatenate(rerep_parts)
    n = restimulus.shape[0]

    emg = (rng.standard_normal((n, 12)) * 0.1).astype(np.float32)
    acc = (rng.standard_normal((n, 36))).astype(np.float32)
    glove = (rng.standard_normal((n, 22))).astype(np.float32)

    mdict = {
        "subject": np.array([[subject]], dtype=np.int16),
        "exercise": np.array([[exercise]], dtype=np.int16),
        "emg": emg,
        "acc": acc,
        "glove": glove,
        "stimulus": restimulus.reshape(-1, 1),  # 합성: stimulus == restimulus
        "restimulus": restimulus.reshape(-1, 1),
        "repetition": rerepetition.reshape(-1, 1),
        "rerepetition": rerepetition.reshape(-1, 1),
    }

    if exercise == 3:
        force = (rng.standard_normal((n, 6))).astype(np.float32)
        forcecal = np.vstack([force.min(axis=0), force.max(axis=0)]).astype(np.float64)
        mdict["force"] = force
        mdict["forcecal"] = forcecal

    path.parent.mkdir(parents=True, exist_ok=True)
    scipy.io.savemat(str(path), mdict)
    return path
