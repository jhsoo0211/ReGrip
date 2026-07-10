-- ============================================================================
-- ReGrip 초기 스키마 (PostgreSQL 15+)
--
-- 이 파일은 docs/backend/01-erd.md 의 PostgreSQL DDL 을 그대로 옮긴 것이며,
-- src/models 의 SQLAlchemy 모델과 **수동으로 정렬**되어 있다(자동 마이그레이션 생성 아님).
-- 스키마 변경 시 이 파일과 ORM 모델을 함께 고쳐야 한다.
--
-- SQLite(개발/테스트)에서는 ORM 이 타입을 폴백한다:
--   uuid -> CHAR(36) 문자열, jsonb -> JSON, citext -> text+애플리케이션 소문자화.
-- 이 파일은 운영(PostgreSQL) 전용이다. SQLite 는 startup 시 Base.metadata.create_all 로 만든다.
--
-- [MVP 추가] 로 표시된 컬럼/테이블은 01-erd.md 원본에 없고 MVP 구현을 위해 추가된 것이다:
--   - sessions.result_snapshot        : 멱등 재제출 시 최초 응답 반환 (02 §4.2, 03 §6)
--   - user_stats.streak_bonus_awarded_for_run : 7일 연속 보너스 run 당 1회 지급 플래그 (03 §1)
--   - refresh_tokens                   : 02-api-spec §2.2
--   - audit_logs                       : 06-security-compliance §5.2
--   - organizations/org_members/care_relations/prescriptions : B2B 선반영 (기능은 Stage 3)
-- ============================================================================

-- 0. 공통 규약 ----------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- updated_at 자동 갱신 트리거 함수 (모든 테이블에 부착)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;


-- 1. 계정 / 프로필 ------------------------------------------------------------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,                    -- argon2id
  role          text NOT NULL DEFAULT 'patient'
                  CHECK (role IN ('patient','therapist','admin')),
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','deleted')),
  deleted_at    timestamptz,                      -- soft delete 시각
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- B2B 선반영: organizations 는 devices FK 보다 먼저 정의되어야 한다(원문 §5 위치를 앞당김).
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text CHECK (type IN ('hospital','rehab_center','clinic','other')),
  biz_reg_no text,                                   -- 사업자등록번호
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  birth_date      date,                            -- age(문자열) → 승격. 나이는 유도값
  gender          text CHECK (gender IN ('male','female','other','unspecified')),
  phone_enc       bytea,                           -- 애플리케이션 레벨 암호화(AES-GCM)
  dominant_hand   text CHECK (dominant_hand IN ('left','right','both')),
  injury_type     text CHECK (injury_type IN
                    ('fracture','tendon','nerve','arthritis','stroke','other')),
  treatment_start date,
  doctor_name     text,                            -- B2C 자유입력 존치. B2B 는 care_relations 대체
  goal_force      smallint CHECK (goal_force BETWEEN 10 AND 100),
  goal_days       smallint CHECK (goal_days IN (3,4,5,7)),
  avatar_url      text,                            -- base64 금지. 오브젝트 스토리지 URL
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_settings (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hand                    text CHECK (hand IN ('left','right','both')),
  difficulty              text CHECK (difficulty IN ('easy','normal','hard')),
  rest_seconds            smallint NOT NULL DEFAULT 30
                            CHECK (rest_seconds BETWEEN 10 AND 120),
  reminder_enabled        boolean NOT NULL DEFAULT true,
  reminder_time           time NOT NULL DEFAULT '09:00',
  session_summary_enabled boolean NOT NULL DEFAULT true,
  -- [MVP 추가] 사용자 로컬 타임존(IANA). streak/일일상한/차트의 달력일 기준.
  timezone                text NOT NULL DEFAULT 'Asia/Seoul',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);


-- 2. 디바이스 / 캘리브레이션 --------------------------------------------------
CREATE TABLE devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_no        text UNIQUE NOT NULL,
  model            text,
  firmware_version text,
  owner_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = 시설 공용
  org_id           uuid REFERENCES organizations(id) ON DELETE SET NULL,
  paired_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calibrations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
  baseline_raw_0   real NOT NULL,   -- force 0 에 대응하는 원시 FSR 값
  baseline_raw_100 real NOT NULL,   -- force 100 에 대응하는 원시 FSR 값
  calibrated_at    timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);


-- 3. 세션 (핵심 트랜잭션 대상) ------------------------------------------------
CREATE TABLE sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_session_id uuid NOT NULL,                 -- 멱등키 (클라 발급)
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_type     text NOT NULL CHECK (exercise_type IN
                      ('game_crane','game_balloon','pinch_hold',
                       'full_grip','finger_ext','lateral_grip')),
  -- label(한글)은 저장하지 않는다. 서버가 exercise_type 에서 유도해 응답 시 채운다.
  started_at        timestamptz NOT NULL,
  duration_sec      integer NOT NULL CHECK (duration_sec > 0),
  set_count         smallint NOT NULL DEFAULT 0,
  avg_force         numeric(5,2) NOT NULL CHECK (avg_force BETWEEN 0 AND 100),
  max_force         numeric(5,2) NOT NULL
                      CHECK (max_force BETWEEN 0 AND 100 AND max_force >= avg_force),
  stars             smallint NOT NULL CHECK (stars BETWEEN 1 AND 3),  -- 서버 재계산
  attempts          smallint NOT NULL DEFAULT 0,
  difficulty        text CHECK (difficulty IN ('easy','normal','hard')),
  hand_used         text CHECK (hand_used IN ('left','right','both')),
  device_id         uuid REFERENCES devices(id) ON DELETE SET NULL,
  calibration_id    bigint REFERENCES calibrations(id) ON DELETE SET NULL,
  force_series      jsonb,                          -- 1Hz 다운샘플. 원시 30~60Hz 저장 안 함
  result_snapshot   jsonb,                          -- [MVP 추가] 멱등 재제출 시 최초 응답 그대로 반환
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sessions_idem UNIQUE (user_id, client_session_id)
);

CREATE TABLE session_sets (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  set_index  smallint NOT NULL,
  reps       smallint,
  avg_force  numeric(5,2) CHECK (avg_force BETWEEN 0 AND 100),
  peak_force numeric(5,2) CHECK (peak_force BETWEEN 0 AND 100),
  hold_sec   integer CHECK (hold_sec >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_session_sets UNIQUE (session_id, set_index)
);


-- 4. 게이미피케이션 ----------------------------------------------------------
CREATE TABLE achievement_definitions (
  id          text PRIMARY KEY,                     -- 슬러그. 예: 'first_pop'
  title       text NOT NULL,
  description text NOT NULL,
  category    text NOT NULL CHECK (category IN
                ('game_play','grip_training','persistence','collection')),
  rarity      text NOT NULL CHECK (rarity IN
                ('common','rare','epic','legendary')),
  reward_xp   integer NOT NULL CHECK (reward_xp BETWEEN 100 AND 500),
  rule_type   text NOT NULL CHECK (rule_type IN
                ('session_count','max_force_gte','streak_days','total_sets')),
  rule_params jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 예: {"threshold": 60}
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_achievements (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id text NOT NULL REFERENCES achievement_definitions(id),
  progress       integer NOT NULL DEFAULT 0,
  target         integer NOT NULL,
  unlocked_at    timestamptz,                        -- NULL = 미달성
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);

CREATE TABLE xp_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     integer NOT NULL,                       -- 적립 XP (양수)
  reason     text NOT NULL CHECK (reason IN
               ('session','achievement','streak_bonus','goal_bonus')),
  ref_type   text,                                   -- 'session' | 'achievement' 등
  ref_id     text,                                   -- 참조 대상 식별자
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_stats (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_xp          integer NOT NULL DEFAULT 0,      -- = SUM(xp_events.amount) 캐시
  level             smallint NOT NULL DEFAULT 1,     -- 유도값 캐시. 공식은 코드
  tier              text NOT NULL DEFAULT 'beginner',-- 유도값 캐시
  current_streak    integer NOT NULL DEFAULT 0,
  longest_streak    integer NOT NULL DEFAULT 0,
  last_session_date date,
  total_sessions    integer NOT NULL DEFAULT 0,
  best_max_force    numeric(5,2),
  -- [MVP 추가] 7일 연속 보너스(+200) 를 streak run 당 1회만 지급하기 위한 플래그.
  streak_bonus_awarded_for_run boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);


-- 인증: refresh_tokens ([MVP 추가], 02-api-spec §2.2) ------------------------
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,          -- 원문 아님(해시 저장)
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,                    -- 회전 체인 추적
  created_at  timestamptz NOT NULL DEFAULT now()
);


-- 5. B2B 선반영 (기능은 Stage 3) ---------------------------------------------
CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('therapist','org_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE care_relations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  therapist_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id            uuid REFERENCES organizations(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','active','ended')),
  consent_at        timestamptz,                     -- 환자 동의 시각. NULL 이면 열람 불가
  started_at        timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE prescriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  care_relation_id uuid NOT NULL REFERENCES care_relations(id) ON DELETE CASCADE,
  exercise_type    text NOT NULL,
  target_force     smallint CHECK (target_force BETWEEN 0 AND 100),
  sets             smallint,
  reps             smallint,
  days_per_week    smallint CHECK (days_per_week BETWEEN 1 AND 7),
  valid_from       date,
  valid_to         date,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);


-- 6. 감사 로그 ([MVP 추가], 06-security-compliance §5.2) ---------------------
CREATE TABLE audit_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id   uuid NOT NULL,              -- 열람 시도자(치료사)
  patient_id uuid NOT NULL,              -- 열람 대상 환자
  action     text NOT NULL,             -- 'view_sessions' | 'view_profile' | 'create_prescription' ...
  result     text NOT NULL DEFAULT 'allowed'
             CHECK (result IN ('allowed','denied')),
  at         timestamptz NOT NULL DEFAULT now(),
  meta       jsonb                       -- IP, 대상 리소스 등
);


-- 7. 인덱스 -------------------------------------------------------------------
CREATE INDEX idx_sessions_user_started
  ON sessions (user_id, started_at DESC);
CREATE INDEX idx_xp_events_user_created
  ON xp_events (user_id, created_at DESC);
CREATE INDEX idx_user_stats_total_xp
  ON user_stats (total_xp DESC);
CREATE INDEX idx_calibrations_user_latest
  ON calibrations (user_id, calibrated_at DESC);
CREATE INDEX idx_refresh_user
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- B2B: 활성 관계만 부분 인덱스
CREATE INDEX idx_care_therapist
  ON care_relations (therapist_user_id) WHERE status = 'active';
CREATE INDEX idx_care_patient
  ON care_relations (patient_user_id) WHERE status = 'active';

-- 감사 로그 조회
CREATE INDEX idx_audit_patient_at ON audit_logs (patient_id, at DESC);
CREATE INDEX idx_audit_actor_at ON audit_logs (actor_id, at DESC);


-- 8. updated_at 트리거 부착 ---------------------------------------------------
CREATE TRIGGER trg_users_updated       BEFORE UPDATE ON users            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_profiles_updated    BEFORE UPDATE ON profiles         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_settings_updated    BEFORE UPDATE ON user_settings    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_devices_updated     BEFORE UPDATE ON devices          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_calibrations_updated BEFORE UPDATE ON calibrations    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sessions_updated    BEFORE UPDATE ON sessions         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_session_sets_updated BEFORE UPDATE ON session_sets    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_ach_def_updated     BEFORE UPDATE ON achievement_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_ach_updated    BEFORE UPDATE ON user_achievements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_user_stats_updated  BEFORE UPDATE ON user_stats       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orgs_updated        BEFORE UPDATE ON organizations    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_org_members_updated BEFORE UPDATE ON org_members      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_care_updated        BEFORE UPDATE ON care_relations   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_prescriptions_updated BEFORE UPDATE ON prescriptions  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
