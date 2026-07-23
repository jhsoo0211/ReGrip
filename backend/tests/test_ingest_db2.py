"""합성 .mat 픽스처로 DB2 인제스트 end-to-end 검증 + 멱등.

임시 SQLite 파일 DB(create_all + seed_sig_labels)에 합성 E1(block B)·E2(block C)·E3(block D) 를
적재하고 dataset/subject/recording/blob/channel/segment 구조, 전역 라벨 코드 해소(오프셋 없음),
glove 옵션(E3 엔 glove 없이 force), 신호/라벨 길이 정렬(B4), blob 파일 존재·sha256 일치,
재적재 멱등, assert_no_overlap 가드를 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from scripts.sig.ingest_db2 import ingest_db2_file
from scripts.sig.make_synthetic_db2 import make_synthetic
from scripts.sig.segments import assert_no_overlap
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

_META = {
    "code": "ninapro_db2",
    "version": "1.0",
    "source_url": "https://ninapro.hevs.ch/instructions/DB2.html",
    "citation": "Atzori et al. (2014) NinaPro DB2",
    "provenance": {"note": "synthetic fixture"},
}


def _fresh_db(tmp_path: Path):
    engine = create_engine(f"sqlite:///{tmp_path / 'ingest.db'}", future=True)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = Session()
    seed_sig_labels(db)
    return db


def _count(db, model) -> int:
    return db.query(model).count()


def test_ingest_end_to_end_and_idempotent(tmp_path):
    db = _fresh_db(tmp_path)
    blob_root = tmp_path / "store"

    # E1(B): glove+inclin, 전역 코드 1,2,3.  E2(C): glove+inclin, 전역 코드 18,19.
    # E3(D): activation+force(glove 없음), 전역 코드 41,42, 라벨을 신호보다 1 짧게(B4 재현).
    e1 = make_synthetic(tmp_path / "S1_E1_A1.mat", subject=1, exercise=1, n_movements=3, reps=2)
    e2 = make_synthetic(tmp_path / "S1_E2_A1.mat", subject=1, exercise=2, n_movements=2, reps=2)
    e3 = make_synthetic(
        tmp_path / "S1_E3_A1.mat", subject=1, exercise=3, n_movements=2, reps=2, label_short_by=1
    )

    rec1 = ingest_db2_file(db, blob_root, e1, dataset_meta=_META)
    rec2 = ingest_db2_file(db, blob_root, e2, dataset_meta=_META)
    rec3 = ingest_db2_file(db, blob_root, e3, dataset_meta=_META)
    assert len({rec1, rec2, rec3}) == 3

    # ── 구조 검증 ──
    assert _count(db, SigDataset) == 1
    assert _count(db, SigSubject) == 1
    recs = db.query(SigRecording).all()
    assert len(recs) == 3
    assert all(r.status == "complete" for r in recs)

    by_token = {r.file_token: r for r in recs}
    assert set(by_token) == {"E1", "E2", "E3"}
    assert by_token["E1"].protocol_block == "B"
    assert by_token["E2"].protocol_block == "C"
    assert by_token["E3"].protocol_block == "D"

    # probe_findings: 전역 코드 모드 + block 허용 범위 + 길이 정렬 기록(오프셋 machinery 없음)
    for tok in ("E1", "E2", "E3"):
        assert by_token[tok].probe_findings["label_code_mode"] == "restimulus_is_global_code"
        assert "label_offset_applied" not in by_token[tok].probe_findings
    assert by_token["E1"].probe_findings["block_code_range"] == [1, 17]
    assert by_token["E2"].probe_findings["block_code_range"] == [18, 40]
    assert by_token["E3"].probe_findings["block_code_range"] == [41, 49]
    assert by_token["E3"].probe_findings["has_force"] is True
    assert by_token["E1"].probe_findings["has_force"] is False
    # (B4) E3 는 라벨이 신호보다 1 짧아 공통 길이로 1 샘플 잘림, E1 은 어긋남 없음.
    assert by_token["E3"].probe_findings["length_alignment"]["truncated"] == 1
    assert by_token["E1"].probe_findings["length_alignment"]["truncated"] == 0

    # blob 개수: E1/E2 = emg/acc/glove = 3, E3 = emg/acc/force = 3 (glove 없음).
    blobs1 = db.query(SigSignalBlob).filter_by(recording_id=rec1).all()
    blobs2 = db.query(SigSignalBlob).filter_by(recording_id=rec2).all()
    blobs3 = db.query(SigSignalBlob).filter_by(recording_id=rec3).all()
    assert {b.modality_group for b in blobs1} == {"emg", "acc", "glove"}
    assert {b.modality_group for b in blobs2} == {"emg", "acc", "glove"}
    assert {b.modality_group for b in blobs3} == {"emg", "acc", "force"}
    assert len(blobs1) == 3 and len(blobs2) == 3 and len(blobs3) == 3

    # 레이트 이원: emg 는 리샘플 안 함(native==stored, preproc None), 나머지는 리샘플됨.
    emg1 = next(b for b in blobs1 if b.modality_group == "emg")
    acc1 = next(b for b in blobs1 if b.modality_group == "acc")
    assert int(emg1.native_rate_hz) == 2000 and int(emg1.stored_rate_hz) == 2000
    assert emg1.preproc_spec_sha256 is None
    assert int(acc1.native_rate_hz) == 148
    assert acc1.preproc_spec_sha256 is not None
    assert acc1.n_samples < emg1.n_samples  # 다운샘플로 샘플수 감소

    # channel 개수: 채널수 = blob 열수 합. E1/E2 = 12+36+22 = 70, E3 = 12+36+6 = 54(glove 없음).
    def _chan_count(blobs):
        ids = [b.id for b in blobs]
        return db.query(SigChannel).filter(SigChannel.blob_id.in_(ids)).count()

    assert _chan_count(blobs1) == 70
    assert _chan_count(blobs2) == 70
    assert _chan_count(blobs3) == 54

    # acc 채널 명명/extra
    acc_chans = (
        db.query(SigChannel)
        .filter_by(blob_id=acc1.id)
        .order_by(SigChannel.col_index)
        .all()
    )
    assert acc_chans[0].name == "ACC_s1_x"
    assert acc_chans[0].extra == {"sensor": 1, "axis": "x"}
    assert acc_chans[5].name == "ACC_s2_z"
    assert all(c.unit == "g" and c.modality == "acc" for c in acc_chans)

    # force 채널 gain/offset(forcecal 로 (raw-min)/(max-min))
    force_blob = next(b for b in blobs3 if b.modality_group == "force")
    force_chans = db.query(SigChannel).filter_by(blob_id=force_blob.id).all()
    assert len(force_chans) == 6
    assert all(c.modality == "force" and c.unit == "mvc_frac" for c in force_chans)
    assert all(c.gain != 1.0 for c in force_chans)  # forcecal span 반영

    # ── segment + 전역 라벨 코드 해소(오프셋 없음) ──
    # block C 의 restimulus 18 → 전역 code 18 (C_01), 예전 오프셋 버그면 35 였다.
    segs2 = db.query(SigSegment).filter_by(recording_id=rec2).all()
    seg_c = next(s for s in segs2 if s.code_in_file == 18)
    label_c = db.get(SigLabel, seg_c.label_id)
    assert label_c.code == 18 and label_c.name == "C_01"

    segs3 = db.query(SigSegment).filter_by(recording_id=rec3).all()
    assert len(segs3) > 0
    assert all(s.ref_rate_hz == 2000 for s in segs3)
    assert all(s.source == "restimulus" for s in segs3)
    # block D 의 restimulus 41 → 전역 code 41 (D_01), 예전 오프셋 버그면 81 로 크래시.
    seg_code41 = next(s for s in segs3 if s.code_in_file == 41)
    label_d = db.get(SigLabel, seg_code41.label_id)
    assert label_d.code == 41 and label_d.name == "D_01"
    # rest(0) 세그먼트도 저장되며 code 0(rest) 라벨로 조인
    seg_rest = next(s for s in segs3 if s.code_in_file == 0)
    assert db.get(SigLabel, seg_rest.label_id).code == 0

    # ── blob 파일 실제 존재 + sha256 DB 값 일치 ──
    npy_files = list(blob_root.rglob("*.npy"))
    assert len(npy_files) >= 4
    for b in db.query(SigSignalBlob).all():
        f = blob_root / b.rel_path
        assert f.exists(), b.rel_path
        assert hashlib.sha256(f.read_bytes()).digest() == b.sha256
        assert f.stat().st_size == b.n_bytes

    # ── 재적재 멱등: 행수·blob 파일 불변 ──
    counts_before = {
        m: _count(db, m)
        for m in (SigDataset, SigSubject, SigRecording, SigSignalBlob, SigChannel, SigSegment)
    }
    files_before = {p.name for p in blob_root.rglob("*.npy")}

    rec1b = ingest_db2_file(db, blob_root, e1, dataset_meta=_META)
    rec2b = ingest_db2_file(db, blob_root, e2, dataset_meta=_META)
    rec3b = ingest_db2_file(db, blob_root, e3, dataset_meta=_META)
    # 이미 complete → 기존 recording id 그대로 반환(no-op)
    assert (rec1b, rec2b, rec3b) == (rec1, rec2, rec3)

    counts_after = {
        m: _count(db, m)
        for m in (SigDataset, SigSubject, SigRecording, SigSignalBlob, SigChannel, SigSegment)
    }
    assert counts_after == counts_before
    assert {p.name for p in blob_root.rglob("*.npy")} == files_before

    db.close()


def test_force_without_forcecal_raises(tmp_path):
    """force 가 있는데 forcecal 이 없으면 TypeError 가 아니라 명확한 ValueError(B5)."""
    import scipy.io

    db = _fresh_db(tmp_path)
    e3 = make_synthetic(tmp_path / "S1_E3_A1.mat", subject=1, exercise=3, n_movements=2, reps=2)
    mat = scipy.io.loadmat(str(e3))
    del mat["forcecal"]  # forcecal 제거 → 방어적 에러 경로
    bad = tmp_path / "S1_E3_bad.mat"
    scipy.io.savemat(str(bad), {k: v for k, v in mat.items() if not k.startswith("__")})

    with pytest.raises(ValueError):
        ingest_db2_file(db, tmp_path / "store", bad, dataset_meta=_META)
    db.close()


def test_assert_no_overlap_rejects_overlap():
    # 정상(반개구간 인접)은 통과
    assert_no_overlap([(0, 10, 1), (10, 20, 0), (20, 30, 2)])
    # 인위적 겹침은 ValueError
    with pytest.raises(ValueError):
        assert_no_overlap([(0, 10, 1), (5, 15, 2)])
