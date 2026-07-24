"""NinaPro DB2 EMG 제스처 분류 학습 CLI — 피험자별(intra-subject), 공식 repetition 분할.

scratchpad/sig_train.py 의 (실데이터로 검증된) 로직을 재현 가능한 CLI 로 정식 편입한 것이다.

특징: 12ch EMG 시간영역 5종(MAV/RMS/WL/ZC/SSC), 창/보폭 인자화(샘플 단위 @2000Hz).
분할: train reps {1,3,4,6} / test {2,5} (Atzori DB2 프로토콜). rest(code 0) 제외 → 49 동작.
모델: RandomForest(150). 지표: 피험자별 test 정확도·균형정확도 + 평균±표준편차.

결과: --out 에 요약 JSON 저장, 같은 디렉터리에 train_preds.npz(y_true/y_pred) 저장.
의존성: requirements-ingest.txt(numpy/scipy) 위에 requirements-ml.txt(scikit-learn) 설치.

예)
    python backend/scripts/ml/train_gesture.py --subjects 1-20
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

# backend 를 import 경로에 추가 (src 패키지 해석용).
_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

TRAIN_REPS, TEST_REPS = {1, 3, 4, 6}, {2, 5}


def feats(win):  # win: [n_win, 12, WIN] → [n_win, 60]
    mav = np.mean(np.abs(win), axis=2)
    rms = np.sqrt(np.mean(win ** 2, axis=2))
    wl = np.sum(np.abs(np.diff(win, axis=2)), axis=2)
    eps = 1e-4
    s = np.sign(win)
    zc = np.sum(
        (s[:, :, :-1] != s[:, :, 1:]) & (np.abs(win[:, :, :-1] - win[:, :, 1:]) > eps),
        axis=2,
    )
    d = np.diff(win, axis=2)
    sd = np.sign(d)
    ssc = np.sum(
        (sd[:, :, :-1] != sd[:, :, 1:]) & (np.abs(d[:, :, :-1]) > eps),
        axis=2,
    )
    return np.concatenate([mav, rms, wl, zc, ssc], axis=1).astype(np.float32)


def windows_for(emg, segs, win, step):
    """segs: [(start,end,code,rep)] → (X[n,60], y[n], rep[n])"""
    Xs, ys, rs = [], [], []
    for start, end, code, rep in segs:
        if code == 0:                       # rest 제외
            continue
        sl = emg[start:end]                 # [seg_len, 12], 2000Hz 1:1 정렬
        if sl.shape[0] < win:
            continue
        sw = np.lib.stride_tricks.sliding_window_view(sl, win, axis=0)  # [L-win+1,12,win]
        sw = sw[::step]                     # [n_win,12,win]
        if sw.shape[0] == 0:
            continue
        Xs.append(feats(sw))
        ys.append(np.full(sw.shape[0], code))
        rs.append(np.full(sw.shape[0], rep))
    if not Xs:
        return np.empty((0, 60), np.float32), np.empty(0, int), np.empty(0, int)
    return np.concatenate(Xs), np.concatenate(ys), np.concatenate(rs)


def parse_subjects(spec: str) -> list[int]:
    """"1-20" 또는 "1,3,5" → 정렬·중복제거된 정수 목록. 혼용("1-3,5")도 허용."""
    out: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            lo, hi = int(a), int(b)
            if lo > hi:
                lo, hi = hi, lo
            out.update(range(lo, hi + 1))
        else:
            out.add(int(part))
    return sorted(out)


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="NinaPro DB2 EMG 제스처 분류 학습 (피험자별 intra-subject, RandomForest).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--db", default=str(_BACKEND / "storage" / "sig_ingest.db"), help="SQLite 카탈로그 DB 경로")
    p.add_argument("--blob-root", default=str(_BACKEND / "storage" / "sig-blobs"), help="신호 blob(.npy) 루트")
    p.add_argument("--win", type=int, default=400, help="창 길이(샘플 @2000Hz)")
    p.add_argument("--step", type=int, default=200, help="보폭(샘플 @2000Hz)")
    p.add_argument(
        "--subjects",
        default=None,
        help='학습 대상 subject 범위(기본: 전체). 예 "1-20" 또는 "1,3,5"',
    )
    p.add_argument(
        "--out",
        default=str(_BACKEND / "storage" / "train_results.json"),
        help="요약 결과 JSON 경로(예측 npz 는 같은 디렉터리의 train_preds.npz)",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    win, step = args.win, args.step
    blob_root = Path(args.blob_root)
    db_path = Path(args.db)

    # ★ src import 전에 DATABASE_URL 을 --db 로 고정한다(engine 이 import 시점에 바인딩됨).
    os.environ["DATABASE_URL"] = "sqlite:///" + str(db_path.resolve()).replace("\\", "/")
    os.environ.setdefault("ENV", "dev")

    # 무거운 import 는 인자 파싱·env 설정 뒤로 미룬다(--help 를 sklearn 없이도 빠르게).
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import accuracy_score, balanced_accuracy_score

    from src.core.db import SessionLocal
    from src.models import SigRecording, SigSegment, SigSignalBlob, SigSubject

    db = SessionLocal()

    def emg_blob_path(rec_id):
        b = db.query(SigSignalBlob).filter_by(recording_id=rec_id, modality_group="emg").one()
        return blob_root / b.rel_path.replace("/", os.sep)

    q = db.query(SigSubject).order_by(SigSubject.source_subject_id)
    if args.subjects:
        wanted = parse_subjects(args.subjects)
        if not wanted:
            print(
                f"[error] --subjects '{args.subjects}' 에서 유효한 subject 를 못 찾음",
                file=sys.stderr,
            )
            return 2
        q = q.filter(SigSubject.source_subject_id.in_(wanted))
    subjects = q.all()
    if not subjects:
        print("[error] 대상 subject 가 DB 에 없다(먼저 ingest_batch.py 로 적재하라)", file=sys.stderr)
        return 2

    print(
        f"학습 대상 피험자: {len(subjects)}명, 창={win}({win/2000*1000:.0f}ms)/보폭={step}, "
        f"train reps {sorted(TRAIN_REPS)} / test {sorted(TEST_REPS)}\n"
    )

    results, all_true, all_pred, all_subj = [], [], [], []
    importances = []  # 피험자별 clf.feature_importances_ (길이 60) 수집 → 나중에 평균.
    t0 = time.perf_counter()
    for subj in subjects:
        sid = subj.source_subject_id
        recs = db.query(SigRecording).filter_by(subject_id=subj.id).all()
        X, y, r = [], [], []
        for rec in recs:
            emg = np.load(emg_blob_path(rec.id))
            segs = [
                (s.start_sample, s.end_sample, s.code_in_file, s.repetition or 0)
                for s in db.query(SigSegment).filter_by(recording_id=rec.id).all()
            ]
            Xr, yr, rr = windows_for(emg, segs, win, step)
            X.append(Xr)
            y.append(yr)
            r.append(rr)
        X, y, r = np.concatenate(X), np.concatenate(y), np.concatenate(r)
        tr = np.isin(r, list(TRAIN_REPS))
        te = np.isin(r, list(TEST_REPS))
        clf = RandomForestClassifier(n_estimators=150, n_jobs=-1, random_state=0)
        clf.fit(X[tr], y[tr])
        # RF 특징 중요도(길이 60 = MAV12·RMS12·WL12·ZC12·SSC12 순) 수집.
        importances.append(np.asarray(clf.feature_importances_, dtype=np.float64))
        pred = clf.predict(X[te])
        acc = accuracy_score(y[te], pred)
        bacc = balanced_accuracy_score(y[te], pred)
        results.append(
            {
                "subject": int(sid),
                "n_train": int(tr.sum()),
                "n_test": int(te.sum()),
                "n_classes": int(len(np.unique(y))),
                "acc": round(float(acc), 4),
                "balanced_acc": round(float(bacc), 4),
            }
        )
        all_true.append(y[te])
        all_pred.append(pred)
        # 각 test 창의 source_subject_id (y_true/y_pred 와 정렬).
        all_subj.append(np.full(int(te.sum()), sid, dtype=int))
        print(
            f"  s{sid:2d}: acc={acc*100:5.2f}%  bal={bacc*100:5.2f}%  "
            f"train={tr.sum():6d} test={te.sum():6d} cls={len(np.unique(y))}  "
            f"({time.perf_counter()-t0:.0f}s)"
        )

    accs = np.array([x["acc"] for x in results])
    baccs = np.array([x["balanced_acc"] for x in results])
    print(f"\n===== 요약 ({len(results)}명) =====")
    print(
        f"  정확도       평균 {accs.mean()*100:.2f}% ± {accs.std()*100:.2f}  "
        f"(min {accs.min()*100:.1f} / max {accs.max()*100:.1f})"
    )
    print(f"  균형정확도   평균 {baccs.mean()*100:.2f}% ± {baccs.std()*100:.2f}")
    print(f"  총 소요 {time.perf_counter()-t0:.0f}s")

    out = {
        "config": {
            "win": win,
            "step": step,
            "train_reps": sorted(TRAIN_REPS),
            "test_reps": sorted(TEST_REPS),
            "features": ["MAV", "RMS", "WL", "ZC", "SSC"],
            "model": "RandomForest(150)",
            "rest_excluded": True,
        },
        # RF 특징 중요도 피험자 평균(길이 60). 순서: MAV[0:12]·RMS[12:24]·WL[24:36]·ZC[36:48]·SSC[48:60],
        # 각 12칸은 EMG 채널 0..11 순. (JSON 에 주석을 못 넣어 order 키로 명시.)
        "feature_importance": [float(v) for v in np.mean(np.stack(importances), axis=0)],
        "feature_importance_order": "MAV[0:12], RMS[12:24], WL[24:36], ZC[36:48], SSC[48:60]; each block = EMG channel 0..11",
        "per_subject": results,
        "summary": {
            "acc_mean": float(accs.mean()),
            "acc_std": float(accs.std()),
            "bal_mean": float(baccs.mean()),
            "bal_std": float(baccs.std()),
        },
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"  결과 저장: {out_path}")

    preds_path = out_path.parent / "train_preds.npz"
    np.savez(
        preds_path,
        y_true=np.concatenate(all_true),
        y_pred=np.concatenate(all_pred),
        y_subject=np.concatenate(all_subj),
    )
    print(f"  예측 저장: {preds_path}")

    db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
