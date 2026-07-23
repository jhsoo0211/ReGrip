"""NinaPro DB2 다수 subject 배치 인제스트 CLI.

scratchpad/sig_ingest_all.py 의 (실데이터로 검증된) 로직을 재현 가능한 CLI 로 정식
편입한 것이다. 하드코딩되어 있던 경로(Downloads / DB / blob-root)를 argparse 인자로
빼고, subject 범위와 --fresh(기존 DB 초기화)를 옵션으로 노출했다. 파일별 실패는 잡아서
계속 진행하고, 마지막에 실패 목록·카탈로그 총계를 출력한다.

전제: DB2_s{N}/S{N}_E{1,2,3}_A1.mat 가 --download-root 아래에 있어야 한다.
의존성 격리: 이 스크립트는 scripts/ 안이라 numpy/scipy 사용이 허용된다(src/ 는 stdlib).

예)
    python backend/scripts/sig/ingest_batch.py --subjects 1-20 --fresh
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date
from pathlib import Path

# backend 를 import 경로에 추가 (src / scripts.sig 패키지 해석용).
_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))


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
        description="NinaPro DB2 다수 subject 배치 인제스트 (subject×E1/E2/E3 → 신호 카탈로그).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--download-root",
        default="~/Downloads",
        help="DB2_s{N}/S{N}_E{1,2,3}_A1.mat 가 있는 루트",
    )
    p.add_argument(
        "--subjects",
        default="1-20",
        help='인제스트할 subject 범위. 예 "1-20" 또는 "1,3,5"',
    )
    p.add_argument(
        "--db",
        default=str(_BACKEND / "storage" / "sig_ingest.db"),
        help="SQLite 카탈로그 DB 경로",
    )
    p.add_argument(
        "--blob-root",
        default=str(_BACKEND / "storage" / "sig-blobs"),
        help="신호 blob(.npy) 저장 루트",
    )
    p.add_argument(
        "--fresh",
        action="store_true",
        help="있으면 기존 DB 파일을 삭제하고 처음부터 적재",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    subjects = parse_subjects(args.subjects)
    if not subjects:
        print(
            f"[error] --subjects '{args.subjects}' 에서 유효한 subject 를 못 찾음",
            file=sys.stderr,
        )
        return 2

    download_root = Path(os.path.expanduser(args.download_root))
    db_path = Path(args.db)
    blob_root = Path(args.blob_root)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    blob_root.mkdir(parents=True, exist_ok=True)

    # ★ src import 전에 DATABASE_URL 을 --db 로 고정한다.
    # config/engine 이 import 시점에 settings.database_url 을 바인딩하므로 순서가 중요하다.
    os.environ["DATABASE_URL"] = "sqlite:///" + str(db_path.resolve()).replace("\\", "/")
    os.environ.setdefault("ENV", "dev")

    if args.fresh and db_path.exists():
        db_path.unlink()
        print(f"[fresh] 기존 DB 삭제: {db_path}")

    # 무거운 import 는 인자 파싱·env 설정 뒤로 미룬다(--help 를 빠르게, DATABASE_URL 반영 보장).
    import glob

    from sqlalchemy import distinct, func

    from scripts.sig.ingest_db2 import ingest_db2_file
    from src.core.db import SessionLocal, engine
    from src.models import (
        Base,
        SigChannel,
        SigDataset,
        SigLabel,
        SigRecording,
        SigSegment,
        SigSignalBlob,
        SigSubject,
    )
    from src.services.signal_vocab import seed_sig_labels

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    print("labels seeded:", seed_sig_labels(db))
    db.commit()

    meta = {
        "code": "ninapro_db2",
        "version": "1.0",
        "provenance": {"cohort": args.subjects, "ingested": date.today().isoformat()},
    }

    t0 = time.perf_counter()
    ok = 0
    fail: list[tuple[str, str]] = []
    n_files = len(subjects) * 3
    print(f"\n===== 배치 인제스트: {len(subjects)}명 × 3 = {n_files} 파일 =====")
    print(f"  download-root: {download_root}")
    for n in subjects:
        subj_ok = 0
        for ex in (1, 2, 3):
            f = download_root / f"DB2_s{n}" / f"S{n}_E{ex}_A1.mat"
            try:
                ingest_db2_file(db, blob_root, f, dataset_meta=meta)
                subj_ok += 1
            except Exception as e:  # noqa: BLE001 — 파일별 실패는 잡아서 계속 진행
                fail.append((f"s{n}_E{ex}", str(e)[:80]))
        ok += subj_ok
        if n % 5 == 0 or subj_ok < 3:
            print(
                f"  s{n}: {subj_ok}/3  (누적 {ok} recordings, {time.perf_counter()-t0:.0f}s)"
            )

    print(
        f"\n총 {ok}/{n_files} recordings 성공, 실패 {len(fail)}건, "
        f"{time.perf_counter()-t0:.0f}s"
    )
    for k, v in fail:
        print("  FAIL", k, v)

    print("\n===== 카탈로그 총계 =====")
    print("  datasets  :", db.query(SigDataset).count())
    print("  subjects  :", db.query(SigSubject).count())
    print("  recordings:", db.query(SigRecording).count())
    print("  blobs     :", db.query(SigSignalBlob).count())
    print("  channels  :", db.query(SigChannel).count())
    print("  segments  :", db.query(SigSegment).count())

    # 라벨 커버리지: 카탈로그에 실제로 등장한 코드
    codes = sorted(
        c[0]
        for c in db.query(distinct(SigLabel.code))
        .join(SigSegment, SigSegment.label_id == SigLabel.id)
        .all()
    )
    if codes:
        print(f"  등장 라벨 코드: {len(codes)}종  min={min(codes)} max={max(codes)}")

    # 모달리티별 blob 수
    print(
        "  모달리티별 blob:",
        dict(
            db.query(SigSignalBlob.modality_group, func.count())
            .group_by(SigSignalBlob.modality_group)
            .all()
        ),
    )

    npys = glob.glob(str(blob_root / "**" / "*.npy"), recursive=True)
    tot = sum(os.path.getsize(p) for p in npys)
    print(f"  blob 파일 {len(npys)}개 (dedup 후), {tot/1024/1024/1024:.2f}GB")

    db.close()
    return 0 if not fail else 1


if __name__ == "__main__":
    raise SystemExit(main())
