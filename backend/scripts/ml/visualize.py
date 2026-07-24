"""ML 가시화 히트맵 4종 생성 CLI — 신호 카탈로그(sig_*)를 눈으로 검증하기 위한 재현 스크립트.

추후 데이터로 다시 돌려도 각 변수(EMG/ACC/Glove/Force)와 제스처를 시각적으로 점검할 수 있게 한다.
train_gesture.py 와 동일한 _BACKEND 앵커·DATABASE_URL 선설정 규칙을 따른다.

생성물(모두 --out-dir 아래 PNG):
  1. ml_emg_gesture.png      — 49동작 × 12 EMG채널, 동작별 평균 RMS(행별 정규화).
  2. ml_modality_gesture.png — emg/acc/glove/force 4패널(변수별 동작 활성, 행별 정규화).
  3. ml_feature_importance.png — RF 특징 중요도(5특징 × 12채널), 피험자 평균.
  4. ml_subject_gesture.png  — 40피험자 × 49동작 test 정확도.

축 라벨은 한글 폰트 이슈를 피하려고 전부 영문으로 쓴다.

예)
    python backend/scripts/ml/visualize.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

# backend 를 import 경로에 추가 (src 패키지 해석용). train_gesture.py 와 동일 앵커.
_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

# ── 모델 상수 (브리프 기준, DB 실측으로 확인) ─────────────────────────────
# segment start/end 는 2kHz 기준 인덱스. EMG blob 은 2kHz 저장이라 [start:end] 1:1.
# acc/glove/force blob 은 native 레이트 저장 → idx_native = round(idx * native/2000).
MODALITY_NATIVE = {"emg": 2000, "acc": 148, "glove": 25, "force": 100}
MODALITY_NCH = {"emg": 12, "acc": 36, "glove": 22, "force": 6}
REF_RATE = 2000  # segment 인덱스 기준 레이트

# 라벨 코드: 0=rest, 1~17 B(E1), 18~40 C(E2), 41~49 D(E3). rest 제외 → 49 동작.
# 각 모달리티가 존재하는 블록에 따라 커버하는 동작 코드가 다르다:
#   emg/acc: 전 블록 → 1..49,  glove: B/C → 1..40,  force: D → 41..49.
CODES = {
    "emg": list(range(1, 50)),
    "acc": list(range(1, 50)),
    "glove": list(range(1, 41)),
    "force": list(range(41, 50)),
}
# 블록 경계(코드 사이): B|C = 17/18 사이, C|D = 40/41 사이.
BLOCK_EDGES = (17, 40)


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="ML 가시화 히트맵 4종(EMG활성·변수별활성·특징중요도·피험자정확도) 생성.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--db", default=str(_BACKEND / "storage" / "sig_ingest.db"), help="SQLite 카탈로그 DB 경로")
    p.add_argument("--blob-root", default=str(_BACKEND / "storage" / "sig-blobs"), help="신호 blob(.npy) 루트")
    p.add_argument("--results", default=str(_BACKEND / "storage" / "train_results.json"), help="학습 요약 JSON")
    p.add_argument("--preds", default=str(_BACKEND / "storage" / "train_preds.npz"), help="예측 npz")
    p.add_argument(
        "--out-dir",
        default=str(_BACKEND.parent / "docs" / "backend" / "assets"),
        help="히트맵 PNG 출력 디렉터리",
    )
    return p.parse_args(argv)


# ── 활성(RMS) 집계 ────────────────────────────────────────────────────────
def aggregate_activation(db, blob_root: str):
    """recording 마다 blob 을 한 번만 load 하고 그 recording 의 segment 들을 처리한다.

    반환: sums[mod][code] = 채널별 RMS 합, cnts[mod][code] = 집계한 segment 수.
    각 segment 의 채널별 RMS = sqrt(mean(x^2)) (그 구간 전체 시간축 평균), 이를 동작 코드별로 평균.
    """
    from src.models import SigRecording, SigSegment, SigSignalBlob

    sums: dict[str, dict[int, np.ndarray]] = {m: {} for m in MODALITY_NATIVE}
    cnts: dict[str, dict[int, int]] = {m: {} for m in MODALITY_NATIVE}

    recs = db.query(SigRecording).all()
    for ri, rec in enumerate(recs, 1):
        seg_tuples = [
            (s.start_sample, s.end_sample, s.code_in_file)
            for s in db.query(SigSegment).filter_by(recording_id=rec.id).all()
        ]
        blobs = db.query(SigSignalBlob).filter_by(recording_id=rec.id).all()
        for b in blobs:
            mod = b.modality_group
            if mod not in MODALITY_NATIVE:
                continue
            path = os.path.join(blob_root, b.rel_path.replace("/", os.sep))
            arr = np.load(path)                      # [n_native, nch], recording 당 1회 load
            native = MODALITY_NATIVE[mod]
            nch = arr.shape[1]
            for start, end, code in seg_tuples:
                if code == 0:                        # rest 제외
                    continue
                if mod == "emg":
                    sl = arr[start:end]              # 2kHz 1:1
                else:
                    a = int(round(start * native / REF_RATE))
                    e = int(round(end * native / REF_RATE))
                    sl = arr[a:e]
                if sl.shape[0] == 0:
                    continue
                rms = np.sqrt(np.mean(sl.astype(np.float64) ** 2, axis=0))  # [nch]
                if code not in sums[mod]:
                    sums[mod][code] = np.zeros(nch, dtype=np.float64)
                    cnts[mod][code] = 0
                sums[mod][code] += rms
                cnts[mod][code] += 1
        if ri % 20 == 0 or ri == len(recs):
            print(f"  집계 진행: recording {ri}/{len(recs)}")
    return sums, cnts


def build_matrix(sums, cnts, mod: str) -> np.ndarray:
    """동작코드(행) × 채널(열) 평균 RMS 행렬. 데이터 없는 코드 행은 NaN."""
    codes = CODES[mod]
    nch = MODALITY_NCH[mod]
    M = np.full((len(codes), nch), np.nan, dtype=np.float64)
    for i, code in enumerate(codes):
        c = cnts[mod].get(code, 0)
        if c > 0:
            M[i] = sums[mod][code] / c
    return M


def row_normalize(M: np.ndarray) -> np.ndarray:
    """행별로 최댓값으로 나눠 각 동작의 채널 프로파일이 보이게 한다(NaN 행은 그대로)."""
    out = M.astype(np.float64).copy()
    for i in range(out.shape[0]):
        row = out[i]
        if np.all(np.isnan(row)):
            continue
        m = np.nanmax(row)
        if m > 0:
            out[i] = row / m
    return out


# ── 축/경계 헬퍼 ──────────────────────────────────────────────────────────
def _gesture_yticks(ax, codes, every=1, fontsize=6):
    idx = [i for i in range(len(codes)) if i % every == 0]
    ax.set_yticks(idx)
    ax.set_yticklabels([str(codes[i]) for i in idx], fontsize=fontsize)


def _channel_xticks(ax, nch, fontsize=6):
    every = 1 if nch <= 12 else 4
    idx = [i for i in range(nch) if i % every == 0]
    ax.set_xticks(idx)
    ax.set_xticklabels([f"ch{i + 1}" for i in idx], fontsize=fontsize, rotation=90)


def _block_hlines(ax, codes):
    """codes 리스트 안에서 B|C(17/18), C|D(40/41) 경계에 수평선을 긋는다."""
    for edge in BLOCK_EDGES:
        # edge 코드와 edge+1 코드가 모두 이 모달리티 코드 목록에 있을 때만 경계선.
        if edge in codes and (edge + 1) in codes:
            i = codes.index(edge)
            ax.axhline(i + 0.5, color="red", lw=1.0, alpha=0.8)


def _block_letters_y(ax, codes):
    """B/C/D 블록 글자를 y축 왼쪽 바깥에 표시(경계선 보조)."""
    trans = ax.get_yaxis_transform()  # x: axes fraction, y: data coords
    ranges = {"B": (1, 17), "C": (18, 40), "D": (41, 49)}
    colors = {"B": "#1f77b4", "C": "#2ca02c", "D": "#d62728"}
    present = set(codes)
    for name, (lo, hi) in ranges.items():
        rows = [i for i, c in enumerate(codes) if lo <= c <= hi]
        if not rows:
            continue
        center = (rows[0] + rows[-1]) / 2.0
        ax.text(-0.14, center, name, transform=trans, ha="center", va="center",
                fontsize=11, fontweight="bold", color=colors[name])


def _imshow_nan(ax, M, cmap_name="viridis", **kw):
    import matplotlib.pyplot as plt

    cmap = plt.get_cmap(cmap_name).copy()
    cmap.set_bad("lightgrey")
    data = np.ma.masked_invalid(M)
    return ax.imshow(data, aspect="auto", interpolation="nearest", cmap=cmap, **kw)


def _stats(M: np.ndarray) -> str:
    finite = M[np.isfinite(M)]
    n_nan = int(np.isnan(M).sum())
    if finite.size == 0:
        return f"shape={M.shape} (all NaN)"
    return (
        f"shape={M.shape} min={finite.min():.4f} max={finite.max():.4f} "
        f"mean={finite.mean():.4f} nan={n_nan}"
    )


# ── 히트맵 4종 ────────────────────────────────────────────────────────────
def plot_emg_gesture(sums, cnts, out_path):
    import matplotlib.pyplot as plt

    M = row_normalize(build_matrix(sums, cnts, "emg"))
    fig, ax = plt.subplots(figsize=(7, 12))
    im = _imshow_nan(ax, M, "viridis")
    _gesture_yticks(ax, CODES["emg"], every=1, fontsize=6)
    _channel_xticks(ax, MODALITY_NCH["emg"], fontsize=7)
    _block_hlines(ax, CODES["emg"])
    _block_letters_y(ax, CODES["emg"])
    ax.set_xlabel("EMG channel")
    ax.set_ylabel("Gesture code")
    ax.set_title("EMG activation per gesture (mean RMS, row-normalized)")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="row-normalized mean RMS")
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return M


def plot_modality_gesture(sums, cnts, out_path):
    import matplotlib.pyplot as plt

    order = ["emg", "acc", "glove", "force"]
    mats = {}
    fig, axes = plt.subplots(2, 2, figsize=(16, 15))
    for ax, mod in zip(axes.ravel(), order):
        M = row_normalize(build_matrix(sums, cnts, mod))
        mats[mod] = M
        im = _imshow_nan(ax, M, "viridis")
        codes = CODES[mod]
        every = 1 if len(codes) <= 12 else 4
        _gesture_yticks(ax, codes, every=every, fontsize=6)
        _channel_xticks(ax, MODALITY_NCH[mod], fontsize=6)
        _block_hlines(ax, codes)
        native = MODALITY_NATIVE[mod]
        ax.set_xlabel(f"{mod} channel")
        ax.set_ylabel("Gesture code")
        ax.set_title(f"{mod.upper()} ({MODALITY_NCH[mod]} ch @ {native} Hz) — mean RMS, row-normalized")
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    fig.suptitle("Per-modality activation per gesture (row-normalized mean RMS)", fontsize=14)
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return mats


def plot_feature_importance(results_path, out_path):
    import matplotlib.pyplot as plt

    with open(results_path, encoding="utf-8") as f:
        res = json.load(f)
    fi = res.get("feature_importance")
    if fi is None:
        raise SystemExit(
            f"[error] {results_path} 에 'feature_importance' 가 없다. "
            f"train_gesture.py 를 (수정본으로) 재실행하라."
        )
    fi = np.asarray(fi, dtype=np.float64)
    if fi.size != 60:
        raise SystemExit(f"[error] feature_importance 길이 {fi.size} != 60")
    FI = fi.reshape(5, 12)  # 행: MAV,RMS,WL,ZC,SSC / 열: EMG ch 0..11
    feat_names = ["MAV", "RMS", "WL", "ZC", "SSC"]

    fig, ax = plt.subplots(figsize=(11, 4.5))
    im = ax.imshow(FI, aspect="auto", interpolation="nearest", cmap="magma")
    ax.set_yticks(range(5))
    ax.set_yticklabels(feat_names)
    ax.set_xticks(range(12))
    ax.set_xticklabels([f"ch{i + 1}" for i in range(12)])
    ax.set_xlabel("EMG channel")
    ax.set_ylabel("Time-domain feature")
    ax.set_title("RandomForest feature importance (mean over 40 subjects)")
    # 셀 값 표기(작아서 가독).
    vmid = FI.max() * 0.6
    for i in range(5):
        for j in range(12):
            ax.text(j, i, f"{FI[i, j]:.3f}", ha="center", va="center",
                    fontsize=6, color="white" if FI[i, j] < vmid else "black")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="mean importance")
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return FI


def plot_subject_gesture(preds_path, out_path):
    import matplotlib.pyplot as plt

    d = np.load(preds_path)
    for k in ("y_true", "y_pred", "y_subject"):
        if k not in d:
            raise SystemExit(
                f"[error] {preds_path} 에 '{k}' 가 없다. train_gesture.py 를 (수정본으로) 재실행하라."
            )
    y_true = d["y_true"].astype(int)
    y_pred = d["y_pred"].astype(int)
    y_subj = d["y_subject"].astype(int)

    subs = np.arange(1, 41)
    gests = np.arange(1, 50)
    M = np.full((len(subs), len(gests)), np.nan, dtype=np.float64)
    correct = (y_pred == y_true)
    for i, s in enumerate(subs):
        smask = y_subj == s
        if not smask.any():
            continue
        yt = y_true[smask]
        cor = correct[smask]
        for j, g in enumerate(gests):
            gm = yt == g
            n = int(gm.sum())
            if n > 0:
                M[i, j] = float(cor[gm].mean())

    fig, ax = plt.subplots(figsize=(15, 10))
    im = _imshow_nan(ax, M, "viridis", vmin=0.0, vmax=1.0)
    ax.set_yticks(range(len(subs)))
    ax.set_yticklabels([str(s) for s in subs], fontsize=6)
    ax.set_xticks(range(len(gests)))
    ax.set_xticklabels([str(g) for g in gests], fontsize=6, rotation=90)
    ax.set_xlabel("Gesture code")
    ax.set_ylabel("Subject")
    ax.set_title("Per-subject per-gesture test accuracy")
    # 동작 블록 경계(세로선).
    for edge in BLOCK_EDGES:
        ax.axvline(edge - 1 + 0.5, color="red", lw=1.0, alpha=0.8)
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="test accuracy (0-1)")
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return M


def main(argv=None) -> int:
    args = parse_args(argv)

    db_path = Path(args.db)
    blob_root = str(Path(args.blob_root))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ★ src import 전에 DATABASE_URL 을 --db 로 고정한다(engine 이 import 시점에 바인딩됨).
    os.environ["DATABASE_URL"] = "sqlite:///" + str(db_path.resolve()).replace("\\", "/")
    os.environ.setdefault("ENV", "dev")

    import matplotlib
    matplotlib.use("Agg")  # 헤드리스 렌더링

    from src.core.db import SessionLocal

    db = SessionLocal()
    print("활성(RMS) 집계 시작 …")
    sums, cnts = aggregate_activation(db, blob_root)
    db.close()

    p1 = out_dir / "ml_emg_gesture.png"
    p2 = out_dir / "ml_modality_gesture.png"
    p3 = out_dir / "ml_feature_importance.png"
    p4 = out_dir / "ml_subject_gesture.png"

    M1 = plot_emg_gesture(sums, cnts, p1)
    mats = plot_modality_gesture(sums, cnts, p2)
    FI = plot_feature_importance(args.results, p3)
    M4 = plot_subject_gesture(args.preds, p4)

    print("\n생성 파일 및 통계:")
    print(f"  {p1}")
    print(f"    emg_gesture         : {_stats(M1)}")
    print(f"  {p2}")
    for mod in ("emg", "acc", "glove", "force"):
        print(f"    modality[{mod:5s}]      : {_stats(mats[mod])}")
    print(f"  {p3}")
    print(f"    feature_importance  : {_stats(FI)}")
    print(f"  {p4}")
    print(f"    subject_gesture     : {_stats(M4)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
