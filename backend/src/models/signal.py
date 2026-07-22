"""신호 카탈로그 모델 (NinaPro DB2/DB9 정렬용). migrations/003_signal_catalog.sql 과 수동 정렬.

recording -> blob -> channel 3층 구조로 1채널 FSR 과 다채널 NinaPro 를 채널 행 수만 다른
동일 구조로 담는다. 원시 벌크는 DB 에 넣지 않는다(카탈로그 메타데이터만; rel_path/sha256 로 파일 참조).

이 테이블들은 insert-only 이므로 updated_at 없이 created_at 만 둔다(CreatedAtMixin).
단, 003 DDL 에 created_at 이 없는 테이블(sig_subject/sig_channel/sig_label)은 SQL 과의 1:1
정렬을 지키기 위해 CreatedAtMixin 을 상속하지 않는다(불필요한 컬럼을 만들지 않음).

SQLite 호환 divergence:
  - sig_signal_blob.ck_sig_blob_relpath 정규식 CHECK 는 PostgreSQL 전용(~ 연산자)이라 ORM 에
    넣지 않는다. SQLite 에서 ~ 는 비트연산이라 의미가 깨진다. 여기서는 rel_path 를 UNIQUE 만
    걸고, 형식 검증은 003 SQL(운영) + 앱/인제스트 레이어가 담당한다.
  - gen_random_uuid() 는 PostgreSQL 전용이라 ORM 은 Python 측 default=_uuid 를 쓴다.
  - bigint IDENTITY 는 ORM 에서 autoincrement PK(SQLite 는 INTEGER 폴백) — calibrations 와 동일.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..core.types import GUID, JSONB
from .base import Base, CreatedAtMixin


def _uuid() -> str:
    return str(uuid.uuid4())


class SigDataset(Base, CreatedAtMixin):
    __tablename__ = "sig_dataset"

    # bigint IDENTITY (PG). SQLite 는 INTEGER autoincrement 폴백.
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    version: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str] = mapped_column(Text, nullable=False)
    license_code: Mapped[str] = mapped_column(Text, nullable=False, default="unverified")
    license_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    redistributable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    citation: Mapped[str] = mapped_column(Text, nullable=False)
    provenance = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        CheckConstraint(
            "license_code IN ('unverified','citation-only','cc0-1.0','cc-by-4.0',"
            "'cc-by-nd-4.0','custom-permission')",
            name="ck_sig_dataset_license",
        ),
        CheckConstraint(
            "redistributable = false OR license_verified_at IS NOT NULL",
            name="ck_sig_dataset_redist",
        ),
    )


class SigSubject(Base):
    __tablename__ = "sig_subject"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    dataset_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("sig_dataset.id", ondelete="CASCADE"), nullable=False
    )
    source_db: Mapped[str] = mapped_column(Text, nullable=False)
    source_subject_id: Mapped[int] = mapped_column(Integer, nullable=False)
    sex: Mapped[str | None] = mapped_column(Text, nullable=True)
    age_years: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    height_cm: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    weight_kg: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    handedness: Mapped[str | None] = mapped_column(Text, nullable=True)
    hand: Mapped[str | None] = mapped_column(Text, nullable=True)
    meta_confidence: Mapped[str] = mapped_column(Text, nullable=False, default="inferred")
    extra = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        CheckConstraint(
            "source_db IN ('DB1','DB2','DB5','DB9')", name="ck_sig_subject_srcdb"
        ),
        CheckConstraint(
            "sex IS NULL OR sex IN ('male','female','unspecified')",
            name="ck_sig_subject_sex",
        ),
        CheckConstraint(
            "meta_confidence IN ('documented','inferred')", name="ck_sig_subject_conf"
        ),
        UniqueConstraint(
            "dataset_id", "source_db", "source_subject_id", name="uq_sig_subject_src"
        ),
    )


class SigRecording(Base, CreatedAtMixin):
    __tablename__ = "sig_recording"

    id: Mapped[str] = mapped_column(GUID, primary_key=True, default=_uuid)
    dataset_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("sig_dataset.id", ondelete="CASCADE"), nullable=False
    )
    subject_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("sig_subject.id", ondelete="CASCADE"), nullable=False
    )
    file_token: Mapped[str] = mapped_column(Text, nullable=False)
    protocol_block: Mapped[str] = mapped_column(Text, nullable=False)
    internal_exercise_scalar: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    source_filename: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="ingesting")
    recorded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    probe_findings = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        CheckConstraint(
            "protocol_block IN ('A','B','C','D')", name="ck_sig_rec_block"
        ),
        CheckConstraint(
            "status IN ('ingesting','complete','failed')", name="ck_sig_rec_status"
        ),
        UniqueConstraint(
            "dataset_id", "subject_id", "file_token", name="uq_sig_recording_file"
        ),
    )


class SigSignalBlob(Base, CreatedAtMixin):
    __tablename__ = "sig_signal_blob"

    id: Mapped[str] = mapped_column(GUID, primary_key=True, default=_uuid)
    recording_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("sig_recording.id", ondelete="CASCADE"), nullable=False
    )
    modality_group: Mapped[str] = mapped_column(Text, nullable=False)
    native_rate_hz: Mapped[float] = mapped_column(Numeric, nullable=False)
    stored_rate_hz: Mapped[float] = mapped_column(Numeric, nullable=False)
    n_samples: Mapped[int] = mapped_column(BigInteger, nullable=False)
    n_channels: Mapped[int] = mapped_column(Integer, nullable=False)
    dtype: Mapped[str] = mapped_column(Text, nullable=False, default="float32")
    layout: Mapped[str] = mapped_column(Text, nullable=False, default="C")
    # 정규식 형식 CHECK(ck_sig_blob_relpath)는 PG 전용이라 ORM 에 없음. 여기선 UNIQUE 만.
    rel_path: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    sha256: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    n_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    preproc_spec_sha256: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "dtype IN ('float32','int16','float64')", name="ck_sig_blob_dtype"
        ),
        CheckConstraint("layout IN ('C','F')", name="ck_sig_blob_layout"),
        UniqueConstraint("recording_id", "modality_group", name="uq_sig_blob_recmod"),
        Index("idx_sig_blob_sha", "sha256"),
    )


class SigChannel(Base):
    __tablename__ = "sig_channel"

    blob_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("sig_signal_blob.id", ondelete="CASCADE"), primary_key=True
    )
    col_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    modality: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    unit_confidence: Mapped[str] = mapped_column(Text, nullable=False, default="inferred")
    gain: Mapped[float] = mapped_column(Float, nullable=False, default=1)
    # 컬럼명 'offset' 은 SQL 예약어 → DB 컬럼명은 명시로 "offset", 파이썬 속성은 offset.
    offset: Mapped[float] = mapped_column("offset", Float, nullable=False, default=0)
    placement: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="good")
    status_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra = mapped_column(JSONB, nullable=False, default=dict)

    __table_args__ = (
        CheckConstraint(
            "modality IN ('emg','acc','joint_angle','force','fsr','inclin','trigger')",
            name="ck_sig_chan_modality",
        ),
        CheckConstraint(
            "unit IN ('mV','g','deg','mvc_frac','n_raw','N','n/a')", name="ck_sig_chan_unit"
        ),
        CheckConstraint(
            "unit_confidence IN ('documented','inferred','unknown')",
            name="ck_sig_chan_uconf",
        ),
        CheckConstraint("status IN ('good','bad')", name="ck_sig_chan_status"),
        UniqueConstraint("blob_id", "name", name="uq_sig_channel_name"),
    )


class SigLabel(Base):
    __tablename__ = "sig_label"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    scheme: Mapped[str] = mapped_column(Text, nullable=False)
    code: Mapped[int] = mapped_column(Integer, nullable=False)
    protocol_block: Mapped[str | None] = mapped_column(Text, nullable=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    taxonomy_ref: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "protocol_block IS NULL OR protocol_block IN ('A','B','C','D')",
            name="ck_sig_label_block",
        ),
        UniqueConstraint("scheme", "code", name="uq_sig_label_scheme_code"),
    )


class SigSegment(Base, CreatedAtMixin):
    __tablename__ = "sig_segment"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    recording_id: Mapped[str] = mapped_column(
        GUID, ForeignKey("sig_recording.id", ondelete="CASCADE"), nullable=False
    )
    ref_rate_hz: Mapped[float] = mapped_column(Numeric, nullable=False)
    start_sample: Mapped[int] = mapped_column(BigInteger, nullable=False)
    end_sample: Mapped[int] = mapped_column(BigInteger, nullable=False)
    code_in_file: Mapped[int] = mapped_column(Integer, nullable=False)
    label_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("sig_label.id"), nullable=False
    )
    repetition: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "source IN ('restimulus','stimulus','manual','auto_onset')",
            name="ck_sig_seg_source",
        ),
        CheckConstraint("end_sample > start_sample", name="ck_sig_seg_order"),
        Index("idx_sig_segment_rec", "recording_id", "start_sample"),
        Index("idx_sig_segment_label", "label_id"),
    )
