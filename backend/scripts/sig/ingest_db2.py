"""NinaPro DB2 .mat → 신호 카탈로그 적재 오케스트레이터 (설계서 §적재 파이프라인).

순서: load(미지 키 abort) → probe → dataset upsert → subject upsert → recording(멱등) →
모달리티별(리샘플 → blob 파일 먼저 → blob 행 → channel 행) → restimulus run-length → segment →
recording status='complete'. blob 은 content-addressed sha256 로 자연 dedup 되어 재실행에 안전.

멱등: 같은 파일 재실행 시 이미 complete 면 no-op(기존 id 반환). 미완료(ingesting/failed)면
해당 recording 을 지우고(cascade) 재적재. → 행수·blob 파일 불변.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from src.models import (
    SigChannel,
    SigDataset,
    SigLabel,
    SigRecording,
    SigSegment,
    SigSignalBlob,
    SigSubject,
)
from src.services.signal_offsets import NATIVE_RATES_DB2, STORED_RATE_DB2, label_offset

from .blobstore import write_blob
from .mat_loader import load_db2_mat, probe
from .preproc import resample_modality, spec_sha256
from .segments import assert_no_overlap, resolve_label_code, run_length

_SCHEME = "ninapro_db2"

# exercise 스칼라 1/2/3 → file_token E1/E2/E3 → protocol_block B/C/D.
# (공식 페이지의 "E1=기본 손가락"은 오류. 설계서 §검증된 사실 그대로 구현.)
_EXERCISE_TO_TOKEN = {1: "E1", 2: "E2", 3: "E3"}
_EXERCISE_TO_BLOCK = {1: "B", 2: "C", 3: "D"}

# modality_group → (channel.modality, channel.unit). 단위 미문서라 전부 unit_confidence='inferred'.
# glove(cyberglove)는 무단위 ADC 라 unit='n/a', 관절각이므로 modality='joint_angle'.
_MODALITY_SPEC = {
    "emg": ("emg", "mV"),
    "acc": ("acc", "g"),
    "glove": ("joint_angle", "n/a"),
    "force": ("force", "mvc_frac"),
}

_ACC_AXES = ("x", "y", "z")


def _scalar_int(mat: dict, key: str) -> int:
    return int(np.asarray(mat[key]).ravel()[0])


def _upsert_dataset(db, meta: dict) -> SigDataset:
    """sig_dataset 을 code 로 멱등 upsert. redistributable=False, license 'citation-only'(설계 확정 #2)."""
    code = str(meta.get("code", "ninapro_db2"))
    row = db.query(SigDataset).filter(SigDataset.code == code).one_or_none()
    if row is None:
        row = SigDataset(code=code)
        db.add(row)
    row.version = str(meta.get("version", "unknown"))
    row.source_url = str(meta.get("source_url", "https://ninapro.hevs.ch/"))
    row.license_code = str(meta.get("license_code", "citation-only"))
    row.redistributable = False  # 가중치만 배포, 원데이터 재배포 안 함
    row.citation = str(
        meta.get(
            "citation",
            "Atzori, M. et al. (2014). Electromyography data for non-invasive "
            "naturally-controlled robotic hand prostheses. Scientific Data. (NinaPro DB2)",
        )
    )
    row.provenance = dict(meta.get("provenance", {}))
    db.flush()
    return row


def _upsert_subject(db, dataset_id: int, source_subject_id: int) -> SigSubject:
    """sig_subject 를 (dataset_id, 'DB2', source_subject_id) 로 멱등 upsert."""
    row = (
        db.query(SigSubject)
        .filter(
            SigSubject.dataset_id == dataset_id,
            SigSubject.source_db == "DB2",
            SigSubject.source_subject_id == source_subject_id,
        )
        .one_or_none()
    )
    if row is None:
        row = SigSubject(
            dataset_id=dataset_id,
            source_db="DB2",
            source_subject_id=source_subject_id,
            meta_confidence="inferred",
        )
        db.add(row)
        db.flush()
    return row


def _build_channels(group: str, n_channels: int, forcecal) -> list[dict]:
    """modality_group·채널수 → sig_channel 행 dict 목록. 명명 규칙·단위·force gain/offset 포함."""
    modality, unit = _MODALITY_SPEC[group]
    rows: list[dict] = []
    for i in range(n_channels):
        gain, offset, extra = 1.0, 0.0, {}
        if group == "emg":
            name = f"EMG_{i + 1}"
        elif group == "acc":
            sensor = i // 3 + 1
            axis = _ACC_AXES[i % 3]
            name = f"ACC_s{sensor}_{axis}"
            extra = {"sensor": sensor, "axis": axis}
        elif group == "glove":
            name = f"CG_{i + 1:02d}"
        else:  # force
            name = f"FORCE_{i + 1}"
            mn = float(forcecal[0, i])
            mx = float(forcecal[1, i])
            span = mx - mn
            if span != 0:
                # pct = (raw-min)/(max-min) = raw*gain + offset
                gain = 1.0 / span
                offset = -mn / span
        rows.append(
            {
                "col_index": i,
                "name": name,
                "modality": modality,
                "unit": unit,
                "unit_confidence": "inferred",
                "gain": gain,
                "offset": offset,
                "extra": extra,
            }
        )
    return rows


def ingest_db2_file(db, blob_root, mat_path, *, dataset_meta: dict):
    """DB2 .mat 한 파일을 신호 카탈로그에 적재하고 recording_id 를 반환한다."""
    blob_root = Path(blob_root)
    mat_path = Path(mat_path)

    # 1) load (미지 키 abort)
    mat = load_db2_mat(mat_path)
    # 2) probe
    findings = probe(mat)

    exercise = _scalar_int(mat, "exercise")
    subject_raw = _scalar_int(mat, "subject")
    if exercise not in _EXERCISE_TO_TOKEN:
        raise ValueError(f"unexpected exercise scalar {exercise} (DB2 uses 1/2/3)")
    file_token = _EXERCISE_TO_TOKEN[exercise]
    block = _EXERCISE_TO_BLOCK[exercise]

    # 3) dataset upsert
    dataset = _upsert_dataset(db, dataset_meta)
    # 4) subject upsert
    subject = _upsert_subject(db, dataset.id, subject_raw)

    # 5) recording (멱등: complete 면 no-op, 미완료면 삭제 후 재적재)
    existing = (
        db.query(SigRecording)
        .filter(
            SigRecording.dataset_id == dataset.id,
            SigRecording.subject_id == subject.id,
            SigRecording.file_token == file_token,
        )
        .one_or_none()
    )
    if existing is not None:
        if existing.status == "complete":
            return existing.id
        db.delete(existing)  # cascade → blob/channel/segment 행 제거(고아 blob 파일은 dedup 로 재사용)
        db.flush()

    offset = label_offset(block)
    recording = SigRecording(
        dataset_id=dataset.id,
        subject_id=subject.id,
        file_token=file_token,
        protocol_block=block,
        internal_exercise_scalar=exercise,
        source_filename=mat_path.name,
        status="ingesting",
        probe_findings={
            **findings,
            "label_offset_mode": "per_file_restart_by_block",
            "label_offset_applied": {block: offset},
        },
    )
    db.add(recording)
    db.flush()

    # 6) 모달리티별 blob + channel
    groups = ["emg", "acc", "glove"]
    if findings["has_force"]:
        groups.append("force")
    forcecal = np.asarray(mat["forcecal"]) if "forcecal" in mat else None

    for group in groups:
        arr = np.asarray(mat[group])
        native = NATIVE_RATES_DB2[group]
        out, spec = resample_modality(arr, native, STORED_RATE_DB2)  # 네이티브로 리샘플
        rel_path, sha, n_bytes = write_blob(blob_root, out)  # 파일 먼저(원자적)
        preproc = None if spec["method"] == "none" else spec_sha256(spec)

        blob = SigSignalBlob(
            recording_id=recording.id,
            modality_group=group,
            native_rate_hz=native,
            stored_rate_hz=STORED_RATE_DB2,
            n_samples=int(out.shape[0]),
            n_channels=int(out.shape[1]),
            dtype="float32",
            layout="C",
            rel_path=rel_path,
            sha256=sha,
            n_bytes=n_bytes,
            preproc_spec_sha256=preproc,
        )
        db.add(blob)
        db.flush()

        for ch in _build_channels(group, int(out.shape[1]), forcecal):
            db.add(SigChannel(blob_id=blob.id, **ch))

    # 7) restimulus run-length → segment
    restim = np.asarray(mat["restimulus"]).ravel().astype(int)
    rerep = np.asarray(mat["rerepetition"]).ravel().astype(int)
    runs = run_length(restim)
    assert_no_overlap(runs)

    label_id_cache: dict[int, int] = {}
    for start, end, value in runs:
        global_code = resolve_label_code(value, block)
        label_id = label_id_cache.get(global_code)
        if label_id is None:
            label = (
                db.query(SigLabel)
                .filter(SigLabel.scheme == _SCHEME, SigLabel.code == global_code)
                .one()
            )
            label_id = label.id
            label_id_cache[global_code] = label_id
        rep_slice = rerep[start:end]
        repetition = int(rep_slice.max()) if rep_slice.size else None
        db.add(
            SigSegment(
                recording_id=recording.id,
                ref_rate_hz=STORED_RATE_DB2,
                start_sample=start,
                end_sample=end,
                code_in_file=value,
                label_id=label_id,
                repetition=repetition,
                source="restimulus",
            )
        )

    # 8) complete
    recording.status = "complete"
    db.commit()
    return recording.id
