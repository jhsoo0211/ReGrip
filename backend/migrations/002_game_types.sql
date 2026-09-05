-- ============================================================================
-- ReGrip 마이그레이션 002 — 게임 타입 확장 + difficulty enum 통일 (PostgreSQL 15+)
--
-- 이 파일은 001_init.sql 과 마찬가지로 src/models 의 SQLAlchemy 모델과 **수동으로 정렬**된다
-- (자동 마이그레이션 생성 아님). 001 이후 프론트가 4게임(balloon/crane/rhythm/glide) 체제로
-- 확장되면서 생긴 3중 불일치(프론트 enum ↔ ORM CHECK ↔ 001 SQL CHECK)를 해소한다.
--
-- SQLite(개발/테스트)는 startup 의 Base.metadata.create_all 이 진실이라 이 파일을 적용하지 않는다.
-- 이 파일은 운영(PostgreSQL) 전용이다. 001 로 만든 DB 위에 순서대로 적용한다:
--   psql "$env:DATABASE_URL" -f migrations/002_game_types.sql
--
-- 변경 요약:
--   1. sessions.exercise_type CHECK: 6종 → 8종 (game_rhythm/game_glide 추가).
--   2. sessions.difficulty CHECK: ('easy','normal','hard') → ('easy','medium','hard').
--   3. user_settings.difficulty CHECK: ('easy','normal','hard') → ('easy','medium','hard').
--   2·3 은 기존 CHECK 제거 → 'normal'을 'medium'으로 변환 → 새 CHECK 추가 순서다.
--
-- 주의(제약 이름): 001 은 위 3개 CHECK 를 컬럼 인라인 CHECK 로 정의했으므로 PostgreSQL 이
--   자동 명명한다(sessions_exercise_type_check / sessions_difficulty_check /
--   user_settings_difficulty_check). 반면 ORM 은 명시 이름(ck_sessions_exercise_type /
--   ck_settings_difficulty)을 쓴다. 어느 이름으로 만들어졌든 안전하게 지우기 위해
--   DROP CONSTRAINT IF EXISTS 를 두 이름 모두에 실행한 뒤, 앞으로는 ORM 과 동일한 명시 이름으로
--   재생성해 이후 정렬을 맞춘다.
-- ============================================================================

BEGIN;

-- 1. sessions.exercise_type — 8종으로 확장 (프론트 GAME_DEFS 4게임과 통일) --------
--    001 인라인 CHECK(sessions_exercise_type_check) 또는 ORM 명시 이름 둘 다 대비해 제거.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_exercise_type_check;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS ck_sessions_exercise_type;
ALTER TABLE sessions ADD CONSTRAINT ck_sessions_exercise_type
  CHECK (exercise_type IN
    ('game_crane','game_balloon','game_rhythm','game_glide',
     'pinch_hold','full_grip','finger_ext','lateral_grip'));

-- 2. sessions.difficulty — 'normal' → 'medium' 통일 (프론트 _normalizeDifficulty 와 일치) --
--    기존 CHECK는 medium을 거부하므로 먼저 제거한 뒤 데이터를 변환한다.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_difficulty_check;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS ck_sessions_difficulty;
UPDATE sessions SET difficulty = 'medium' WHERE difficulty = 'normal';
ALTER TABLE sessions ADD CONSTRAINT ck_sessions_difficulty
  CHECK (difficulty IN ('easy','medium','hard'));

-- 3. user_settings.difficulty — 'normal' → 'medium' 통일 (ORM ck_settings_difficulty 와 일치) --
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS user_settings_difficulty_check;
ALTER TABLE user_settings DROP CONSTRAINT IF EXISTS ck_settings_difficulty;
UPDATE user_settings SET difficulty = 'medium' WHERE difficulty = 'normal';
ALTER TABLE user_settings ADD CONSTRAINT ck_settings_difficulty
  CHECK (difficulty IN ('easy','medium','hard'));

COMMIT;
