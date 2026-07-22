"""합성 .mat 픽스처로 DB2 인제스트 end-to-end 검증 + 멱등.

임시 SQLite 파일 DB(create_all + seed_sig_labels)에 합성 E1(block B)·E3(block D) 를 적재하고
dataset/subject/recording/blob/channel/segment 구조, 라벨 코드 해소, blob 파일 존재·sha256 일치,
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

    e1 = make_synthetic(tmp_path / "S1_E1_A1.mat", subject=1, exercise=1, n_movements=3, reps=2)
    e3 = make_synthetic(tmp_path / "S1_E3_A1.mat", subject=1, exercise=3, n_movements=2, reps=2)

    rec1 = ingest_db2_file(db, blob_root, e1, dataset_meta=_META)
    rec3 = ingest_db2_file(db, blob_root, e3, dataset_meta=_META)
    assert rec1 != rec3

    # ── 구조 검증 ──
    assert _count(db, SigDataset) == 1
    assert _count(db, SigSubject) == 1
    recs = db.query(SigRecording).all()
    assert len(recs) == 2
    assert all(r.status == "complete" for r in recs)

    by_token = {r.file_token: r for r in recs}
    assert set(by_token) == {"E1", "E3"}
    assert by_token["E1"].protocol_block == "B"
    assert by_token["E3"].protocol_block == "D"
    # probe_findings 기록
    assert by_token["E1"].probe_findings["label_offset_mode"] == "per_file_restart_by_block"
    assert by_token["E1"].probe_findings["label_offset_applied"] == {"B": 0}
    assert by_token["E3"].probe_findings["label_offset_applied"] == {"D": 40}
    assert by_token["E3"].probe_findings["has_force"] is True
    assert by_token["E1"].probe_findings["has_force"] is False

    # blob 개수: E1 = emg/acc/glove = 3, E3 = +force = 4
    blobs1 = db.query(SigSignalBlob).filter_by(recording_id=rec1).all()
    blobs3 = db.query(SigSignalBlob).filter_by(recording_id=rec3).all()
    assert len(blobs1) == 3
    assert len(blobs3) == 4
    assert {b.modality_group for b in blobs1} == {"emg", "acc", "glove"}
    assert {b.modality_group for b in blobs3} == {"emg", "acc", "glove", "force"}

    # 레이트 이원: emg 는 리샘플 안 함(native==stored, preproc None), 나머지는 리샘플됨.
    emg1 = next(b for b in blobs1 if b.modality_group == "emg")
    acc1 = next(b for b in blobs1 if b.modality_group == "acc")
    assert int(emg1.native_rate_hz) == 2000 and int(emg1.stored_rate_hz) == 2000
    assert emg1.preproc_spec_sha256 is None
    assert int(acc1.native_rate_hz) == 148
    assert acc1.preproc_spec_sha256 is not None
    assert acc1.n_samples < emg1.n_samples  # 다운샘플로 샘플수 감소

    # channel 개수: 채널수 = blob 열수 합. E1 = 12+36+22 = 70, E3 = +6 = 76.
    def _chan_count(blobs):
        ids = [b.id for b in blobs]
        return db.query(SigChannel).filter(SigChannel.blob_id.in_(ids)).count()

    assert _chan_count(blobs1) == 70
    assert _chan_count(blobs3) == 76

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

    # ── segment + 라벨 코드 해소 ──
    segs3 = db.query(SigSegment).filter_by(recording_id=rec3).all()
    assert len(segs3) > 0
    assert all(s.ref_rate_hz == 2000 for s in segs3)
    assert all(s.source == "restimulus" for s in segs3)
    # block D 의 restimulus 1 → 전역 code 41 (D_01)
    seg_code1 = next(s for s in segs3 if s.code_in_file == 1)
    label = db.get(SigLabel, seg_code1.label_id)
    assert label.code == 41
    assert label.name == "D_01"
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
    rec3b = ingest_db2_file(db, blob_root, e3, dataset_meta=_META)
    # 이미 complete → 기존 recording id 그대로 반환(no-op)
    assert rec1b == rec1
    assert rec3b == rec3

    counts_after = {
        m: _count(db, m)
        for m in (SigDataset, SigSubject, SigRecording, SigSignalBlob, SigChannel, SigSegment)
    }
    assert counts_after == counts_before
    assert {p.name for p in blob_root.rglob("*.npy")} == files_before

    db.close()


def test_assert_no_overlap_rejects_overlap():
    # 정상(반개구간 인접)은 통과
    assert_no_overlap([(0, 10, 1), (10, 20, 0), (20, 30, 2)])
    # 인위적 겹침은 ValueError
    with pytest.raises(ValueError):
        assert_no_overlap([(0, 10, 1), (5, 15, 2)])
