-- ============================================================================
-- ReGrip 마이그레이션 003 — 신호 카탈로그 스키마 기반 (PostgreSQL 15+)
--
-- 이 파일은 001_init.sql / 002_game_types.sql 와 마찬가지로 src/models 의 SQLAlchemy 모델
-- (src/models/signal.py)과 **수동으로 정렬**된다(자동 마이그레이션 생성 아님).
--
-- 목적: NinaPro DB2/DB9 다채널·이종 샘플레이트 시계열을 recording -> blob -> channel 3층으로
--   담아, 1채널 FSR 과 70채널 NinaPro 가 채널 행 수만 다른 동일 구조가 되게 한다.
--   원시 벌크는 DB 에 넣지 않는다(카탈로그 메타데이터만; rel_path/sha256 로 파일 참조).
--
-- SQLite(개발/테스트)는 startup 의 Base.metadata.create_all 이 진실이라 이 파일을 적용하지 않는다.
-- 이 파일은 운영(PostgreSQL) 전용이다. 001·002 로 만든 DB 위에 순서대로 적용한다:
--   psql "$env:DATABASE_URL" -f migrations/003_signal_catalog.sql
--
-- 규약(001/002 교훈 반영):
--   - 모든 CHECK 는 명시 이름 ck_* 로 선언하고 ORM 과 동일 이름·동일 값목록을 쓴다.
--     (001 인라인 익명 CHECK ↔ ORM 명시명 불일치가 002 를 낳았다. 재발 방지.)
--   - NULL 허용 CHECK 는 `X IS NULL OR (...)` 형태(SQLite 호환).
--   - rel_path 정규식 CHECK(ck_sig_blob_relpath)는 PostgreSQL 전용(~ 연산자)이라 이 파일에만 둔다.
--     ORM/SQLite 는 UNIQUE 만 걸고 형식 검증은 앱/인제스트 레이어가 담당한다.
--   - 컬럼명 "offset" 은 SQL 예약어라 인용한다.
-- ============================================================================

BEGIN;

CREATE TABLE sig_dataset (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL UNIQUE,
  version             text NOT NULL,
  source_url          text NOT NULL,
  license_code        text NOT NULL DEFAULT 'unverified'
      CONSTRAINT ck_sig_dataset_license CHECK (license_code IN
      ('unverified','citation-only','cc0-1.0','cc-by-4.0','cc-by-nd-4.0','custom-permission')),
  license_verified_at timestamptz,
  redistributable     boolean NOT NULL DEFAULT false,
  citation            text NOT NULL,
  provenance          jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sig_dataset_redist
      CHECK (redistributable = false OR license_verified_at IS NOT NULL)
);

CREATE TABLE sig_subject (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dataset_id        bigint NOT NULL REFERENCES sig_dataset(id) ON DELETE CASCADE,
  source_db         text NOT NULL
      CONSTRAINT ck_sig_subject_srcdb CHECK (source_db IN ('DB1','DB2','DB5','DB9')),
  source_subject_id int  NOT NULL,
  sex               text CONSTRAINT ck_sig_subject_sex
                        CHECK (sex IS NULL OR sex IN ('male','female','unspecified')),
  age_years         smallint,
  height_cm         smallint,
  weight_kg         smallint,
  handedness        text,
  hand              text,
  meta_confidence   text NOT NULL DEFAULT 'inferred'
      CONSTRAINT ck_sig_subject_conf CHECK (meta_confidence IN ('documented','inferred')),
  extra             jsonb NOT NULL DEFAULT '{}',
  UNIQUE (dataset_id, source_db, source_subject_id)
);

CREATE TABLE sig_recording (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id               bigint NOT NULL REFERENCES sig_dataset(id) ON DELETE CASCADE,
  subject_id               bigint NOT NULL REFERENCES sig_subject(id) ON DELETE CASCADE,
  file_token               text NOT NULL,
  protocol_block           text NOT NULL
      CONSTRAINT ck_sig_rec_block CHECK (protocol_block IN ('A','B','C','D')),
  internal_exercise_scalar smallint,
  source_filename          text NOT NULL,
  status                   text NOT NULL DEFAULT 'ingesting'
      CONSTRAINT ck_sig_rec_status CHECK (status IN ('ingesting','complete','failed')),
  recorded_at              timestamptz,
  probe_findings           jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, subject_id, file_token)
);

CREATE TABLE sig_signal_blob (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id        uuid NOT NULL REFERENCES sig_recording(id) ON DELETE CASCADE,
  modality_group      text NOT NULL,
  native_rate_hz      numeric NOT NULL,
  stored_rate_hz      numeric NOT NULL,
  n_samples           bigint NOT NULL,
  n_channels          int    NOT NULL,
  dtype               text NOT NULL DEFAULT 'float32'
      CONSTRAINT ck_sig_blob_dtype CHECK (dtype IN ('float32','int16','float64')),
  layout              text NOT NULL DEFAULT 'C'
      CONSTRAINT ck_sig_blob_layout CHECK (layout IN ('C','F')),
  rel_path            text NOT NULL UNIQUE
      CONSTRAINT ck_sig_blob_relpath
      CHECK (rel_path ~ '^blobs/sha256/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\.npy$'),
  sha256              bytea NOT NULL,
  n_bytes             bigint NOT NULL,
  preproc_spec_sha256 bytea,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, modality_group)
);
CREATE INDEX idx_sig_blob_sha ON sig_signal_blob (sha256);

CREATE TABLE sig_channel (
  blob_id            uuid NOT NULL REFERENCES sig_signal_blob(id) ON DELETE CASCADE,
  col_index          int  NOT NULL,
  name               text NOT NULL,
  modality           text NOT NULL
      CONSTRAINT ck_sig_chan_modality CHECK (modality IN
      ('emg','acc','joint_angle','force','fsr','inclin','trigger')),
  unit               text NOT NULL
      CONSTRAINT ck_sig_chan_unit CHECK (unit IN ('mV','g','deg','mvc_frac','n_raw','N','n/a')),
  unit_confidence    text NOT NULL DEFAULT 'inferred'
      CONSTRAINT ck_sig_chan_uconf CHECK (unit_confidence IN ('documented','inferred','unknown')),
  gain               double precision NOT NULL DEFAULT 1,
  "offset"           double precision NOT NULL DEFAULT 0,
  placement          text,
  status             text NOT NULL DEFAULT 'good'
      CONSTRAINT ck_sig_chan_status CHECK (status IN ('good','bad')),
  status_description text,
  extra              jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (blob_id, col_index),
  UNIQUE (blob_id, name)
);

CREATE TABLE sig_label (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scheme         text NOT NULL,
  code           int  NOT NULL,
  protocol_block text
      CONSTRAINT ck_sig_label_block CHECK (protocol_block IS NULL OR protocol_block IN ('A','B','C','D')),
  name           text NOT NULL,
  taxonomy_ref   text,
  UNIQUE (scheme, code)
);

CREATE TABLE sig_segment (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recording_id  uuid   NOT NULL REFERENCES sig_recording(id) ON DELETE CASCADE,
  ref_rate_hz   numeric NOT NULL,
  start_sample  bigint NOT NULL,
  end_sample    bigint NOT NULL,
  code_in_file  int    NOT NULL,
  label_id      bigint NOT NULL REFERENCES sig_label(id),
  repetition    int,
  source        text   NOT NULL
      CONSTRAINT ck_sig_seg_source CHECK (source IN ('restimulus','stimulus','manual','auto_onset')),
  confidence    real,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_sig_seg_order CHECK (end_sample > start_sample)
);
CREATE INDEX idx_sig_segment_rec   ON sig_segment (recording_id, start_sample);
CREATE INDEX idx_sig_segment_label ON sig_segment (label_id);

COMMIT;

-- ----------------------------------------------------------------------------
-- 라벨 어휘 seed (sig_label)
--
-- 실제 seed 는 앱 계층(src/services/signal_vocab.py::seed_sig_labels)이 담당하며,
-- data/labels_ninapro_hand_v1.json(NinaPro DB2 동작 50행: 0=rest, 1-17=B, 18-40=C, 41-49=D)을
-- (scheme, code) 기준으로 멱등 upsert 한다.
--
-- 운영(PG)에서 SQL 로 직접 seed 하고 싶다면 아래처럼 멱등 INSERT 를 쓴다(예시):
--   INSERT INTO sig_label (scheme, code, protocol_block, name) VALUES
--     ('ninapro_db2', 0, NULL, 'rest'),
--     ('ninapro_db2', 1, 'B',  'B_01')
--     -- ... (data/labels_ninapro_hand_v1.json 참조)
--   ON CONFLICT (scheme, code) DO NOTHING;
-- ----------------------------------------------------------------------------
