"""DB2 .mat 로드 · 키 검증 · probe (scipy.io 사용).

DB2 .mat 의 알려진 변수만 허용하고, 미지 키가 있으면 조용히 무시하지 않고 abort 한다
(데이터 형상 변화를 놓치지 않기 위함). probe 는 적재 전에 파일의 사실을 실측한다
(restimulus 범위, force 유무 등) — 이 결과가 recording.probe_findings 에 기록되어 가역성을 준다.
"""
from __future__ import annotations

import numpy as np
import scipy.io

# DB2 .mat 의 알려진 변수(실 probe 로 확정). force/forcecal 는 E3 만, glove 는 E1/E2 만.
# inclin(E1/E2 경사계)·activation(E3)은 제스처/힘 학습에 불필요해 blob 으로 적재하진 않지만,
# 실파일에 존재하므로 로드는 허용해야 한다(없으면 "unexpected keys" 로 3파일 다 거부됨).
DB2_KNOWN_KEYS = {
    "subject",
    "exercise",
    "emg",
    "acc",
    "glove",
    "inclin",
    "activation",
    "stimulus",
    "restimulus",
    "repetition",
    "rerepetition",
    "force",
    "forcecal",
}


def _is_internal(key: str) -> bool:
    """scipy.io.loadmat 이 넣는 내부 키(__header__/__version__/__globals__)."""
    return key.startswith("__") and key.endswith("__")


def load_db2_mat(path) -> dict:
    """.mat 로드 후 알려진 키 외의 변수가 있으면 ValueError 로 abort(조용히 무시 금지)."""
    mat = scipy.io.loadmat(str(path))
    unknown = sorted(k for k in mat if not (_is_internal(k) or k in DB2_KNOWN_KEYS))
    if unknown:
        raise ValueError(f"unexpected keys in DB2 .mat {path!s}: {unknown}")
    return mat


def probe(mat: dict) -> dict:
    """적재 전 파일 사실 실측. restimulus 오프셋이 미검증이므로 max 등을 기록해 가역성 확보."""
    restim = np.asarray(mat["restimulus"]).ravel().astype(int)
    findings = {
        "unique_restimulus": sorted(int(v) for v in set(restim.tolist())),
        "max_restimulus": int(restim.max()) if restim.size else 0,
        "n_samples": int(np.asarray(mat["emg"]).shape[0]),
        "has_force": "force" in mat,
        "force_all_zero": None,
        "forcecal_shape": None,
    }
    if "force" in mat:
        force = np.asarray(mat["force"])
        findings["force_all_zero"] = bool(np.all(force == 0))
    if "forcecal" in mat:
        findings["forcecal_shape"] = list(np.asarray(mat["forcecal"]).shape)
    return findings
