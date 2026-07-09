# 01. 데이터 모델 / ERD

> **한 줄 요약**: PostgreSQL 15+ 기반 스키마 전체 DDL. 기본 3NF에 의도적 반정규화 2곳(`sessions` 요약, `user_stats` 캐시)을 두고, `xp_events`를 원장(ledger)으로 삼아 재대사 가능성을 확보한다. B2B 테이블은 지금 선반영하되 기능은 나중.

## 관련 문서
- 상위 원칙: [00-overview.md](./00-overview.md) (원칙 ①~④)
- 이 스키마를 소비하는 API: [02-api-spec.md](./02-api-spec.md)
- XP/레벨/업적 계산 규칙과 트랜잭션: [03-gamification-engine.md](./03-gamification-engine.md)
- B2B 테이블 상세 설명: [07-b2b-extension.md](./07-b2b-extension.md)
- 암호화/민감정보 컬럼 근거: [06-security-compliance.md](./06-security-compliance.md)

---

## 0. 공통 규약

- **DBMS**: PostgreSQL 15+ (`gen_random_uuid()`, `citext`, `IDENTITY` 컬럼 사용)
- **확장**: `pgcrypto`(uuid/암호화), `citext`(대소문자 무시 이메일)
- **모든 테이블에 `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`** 를 둔다. `updated_at`은 트리거로 갱신한다.
- **시간은 전부 `timestamptz`** (UTC 저장). `date`는 자연 날짜(생일, 훈련 시작일 등)에만 사용.
- PK: 외부 노출 식별자는 `uuid`(추측·열거 방지), 내부 append-only 로그는 `bigint IDENTITY`(공간·정렬 효율).

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- updated_at 자동 갱신 트리거 함수 (모든 테이블에 부착)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
```

> **결정(Decision)**: 외부 노출 PK는 uuid, 로그성 테이블은 bigint IDENTITY로 이원화한다.
>
> **근거(Why)**: 세션/유저 ID는 URL·클라에 노출되므로 순차 정수는 열거 공격·규모 노출 위험이 있다. 반면 `xp_events`/`session_sets`/`calibrations` 같은 append-only 로그는 외부 노출이 없고 대량이므로 정렬·저장 효율이 좋은 bigint가 낫다.
>
> **기각된 대안(Rejected)**: 전 테이블 uuid — 로그 테이블 인덱스 팽창·정렬 비용. 전 테이블 순차 int — 외부 식별자 열거 위험.

---

## 1. 계정 / 프로필

### 1.1 users

```sql
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
```

- `email`은 `citext`로 대소문자 무시 유일성 보장.
- `status='deleted'` + `deleted_at`으로 **soft delete**. 탈퇴 즉시 접근 차단, 30일 후 파기 배치([06](./06-security-compliance.md) 참조).

### 1.2 profiles

프로토타입 profile 11필드를 정규화·타입 승격한 결과다.

```sql
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
  doctor_name     text,                            -- B2C 자유입력 존치. B2B는 care_relations가 대체
  goal_force      smallint CHECK (goal_force BETWEEN 10 AND 100),
  goal_days       smallint CHECK (goal_days IN (3,4,5,7)),
  avatar_url      text,                            -- base64 금지. 오브젝트 스토리지 URL
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

> **결정(Decision)**: `age`(문자열) → `birth_date`(date)로 승격하고 나이는 조회 시점 유도값으로 계산한다. `goal_force`(문자열) → `smallint`. `avatarBase64`(data URL) → `avatar_url`(스토리지 링크).
>
> **근거(Why)**: 나이는 시간이 지나면 변하는 파생값이라 저장하면 낡는다. `birth_date`가 진실이고 나이는 유도된다. 또한 `birth_date`는 만 14세 미만 법정대리인 동의 판별([06](./06-security-compliance.md))에도 쓰인다. base64 아바타를 컬럼에 통짜로 넣으면 로우가 비대해지고 세션/프로필 조회마다 수십~수백 KB를 끌고 다니게 된다.
>
> **기각된 대안(Rejected)**: `age`를 그대로 int 저장 — 매년 낡음, 생일 판별 불가. 아바타 base64 컬럼 유지 — 로우 비대·조회 비용·백업 팽창. (과도기 호환은 [02](./02-api-spec.md)에서 서버가 base64를 받아 디코드·업로드 후 URL로 치환.)

### 1.3 user_settings

```sql
CREATE TABLE user_settings (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hand                    text CHECK (hand IN ('left','right','both')),
  difficulty              text CHECK (difficulty IN ('easy','normal','hard')),
  rest_seconds            smallint NOT NULL DEFAULT 30
                            CHECK (rest_seconds BETWEEN 10 AND 120),
  reminder_enabled        boolean NOT NULL DEFAULT true,
  reminder_time           time NOT NULL DEFAULT '09:00',
  session_summary_enabled boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
```

프로토타입 settings(`hand`, `difficulty`, `restSeconds`)에 알림 설정(`reminder_*`, `session_summary_enabled`)을 추가 반영했다.

---

## 2. 디바이스 / 캘리브레이션

### 2.1 devices

```sql
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
```

- `owner_user_id`가 NULL이면 **시설 공용 기기**(B2B 대기실/재활센터 공유). 개인 소유면 해당 유저.

### 2.2 calibrations — 이력 보존(덮어쓰기 금지)

```sql
CREATE TABLE calibrations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id        uuid REFERENCES devices(id) ON DELETE SET NULL,
  baseline_raw_0   real NOT NULL,   -- force 0에 대응하는 원시 FSR 값
  baseline_raw_100 real NOT NULL,   -- force 100에 대응하는 원시 FSR 값
  calibrated_at    timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

> **결정(Decision)**: 캘리브레이션은 **덮어쓰지 않고 이력으로 누적**한다. 세션은 자신이 측정된 시점의 `calibration_id`를 참조한다. "현재 값"은 최신 1건을 인덱스로 조회한다.
>
> **근거(Why)**: 세션이 어떤 캘리브레이션 기준으로 측정됐는지 추적하는 것이 재활 데이터의 **임상적 의미**를 지킨다. 센서를 재보정하면 force 스케일이 바뀌므로, 과거 세션의 `avgForce=40`과 재보정 후 `avgForce=40`은 서로 다른 실제 힘일 수 있다. 이력이 없으면 시계열 비교가 오염된다.
>
> **기각된 대안(Rejected)**: `user_settings`에 최신 baseline만 저장(덮어쓰기) — 재보정 시 과거 세션의 측정 맥락이 소실되어 추이 분석이 무의미해짐.

---

## 3. 세션 (핵심 트랜잭션 대상)

### 3.1 sessions

```sql
CREATE TABLE sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_session_id uuid NOT NULL,                 -- 멱등키 (클라 발급)
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exercise_type     text NOT NULL CHECK (exercise_type IN
                      ('game_crane','game_balloon','pinch_hold',
                       'full_grip','finger_ext','lateral_grip')),
  -- label(한글)은 저장하지 않는다. 서버가 exercise_type에서 유도해 응답 시 채운다.
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
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sessions_idem UNIQUE (user_id, client_session_id)
);
```

핵심 결정들:

> **결정(Decision) — label 비저장**: `label`('풍선 게임' 등 한글)은 DB에 저장하지 않는다. `exercise_type`(enum)만 저장하고, 응답 시 서버가 매핑 테이블로 한글 라벨을 유도한다.
>
> **근거(Why)**: 표시 문자열은 다국어·리네이밍 대상이라 데이터가 아니라 프레젠테이션이다. enum이 진실이면 라벨 변경이 마이그레이션 없이 가능하다.
>
> **기각된 대안(Rejected)**: 한글 라벨 저장 — 라벨 변경 시 전 로우 마이그레이션, 다국어 불가.

> **결정(Decision) — max_force >= avg_force를 CHECK로**: DB 제약으로 물리적으로 불가능한 값(평균 > 최대)을 막는다.
>
> **근거(Why)**: 서버 검증([03](./03-gamification-engine.md)의 422 검증)이 1차 방어선이지만, DB 제약은 버그·경로 우회에도 무결성을 지키는 최후 방어선이다.
>
> **기각된 대안(Rejected)**: 애플리케이션 검증에만 의존 — 코드 경로 하나만 누락돼도 오염 데이터 유입.

> **결정(Decision) — force_series는 1Hz 다운샘플 jsonb, 원시 미저장**: 센서 원시 30~60Hz는 저장하지 않고, 1Hz로 다운샘플한 요약 시계열만 `jsonb`로 담는다.
>
> **근거(Why)**: 15분 세션 원시는 수만 샘플이다. 초기 규모에서 원시 시계열 저장은 낭비이고, 게임 루프도 로컬에서 돌기 때문에 서버는 요약만 필요하다. 상세 근거는 [04-sensor-data-policy.md](./04-sensor-data-policy.md).
>
> **기각된 대안(Rejected)**: 원시 시계열 전량 저장/스트리밍 — 인프라·저장 비용 과다. 임상용 원시 계약은 Stage 3에서 별도 경로([05](./05-scaling-roadmap.md)).

이 테이블은 **write-once/read-many 반정규화** 대상이다. 요약 통계(`avg_force`, `max_force`, `stars`)를 세션 로우에 직접 박아, 조회 시 세트 재집계를 하지 않는다.

### 3.2 session_sets

```sql
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
```

> **주의**: MVP API에서 `sets` 배열은 **optional**이다. 현 프로토타입은 세트별 데이터를 계산 후 폐기하므로, 프론트가 세트별 기록을 보내기 전까지 이 테이블은 비어 있을 수 있다. 프론트의 세트별 기록 기능(스키마 v2: `gameId`/`attempts`/`durationSec`/`setDetails[]`)은 **별도 과제**다. 백엔드는 배열이 오면 저장하고, 안 오면 세션 요약만 저장한다.

---

## 4. 게이미피케이션

계산 규칙은 [03-gamification-engine.md](./03-gamification-engine.md)에 있다. 여기서는 스키마만 정의한다.

### 4.1 achievement_definitions — 업적 정의(하이브리드 규칙)

```sql
CREATE TABLE achievement_definitions (
  id          text PRIMARY KEY,                     -- 슬러그. 예: 'first_session'
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
```

> `category`/`rarity`는 실물 스키마(게임 플레이/악력 훈련/지속성/수집, 일반/희귀/에픽/전설)를 enum 코드로 매핑한다. 표시 한글은 응답 시 유도.

> **결정(Decision) — 하이브리드 룰**: 업적 판정은 `rule_type`별 **코드**로 하고, 임계값 등 파라미터는 `rule_params jsonb`에 **DB로** 둔다.
>
> **근거(Why)**: 순수 하드코딩은 임계값 하나 바꾸려 해도 배포가 필요하다. 반대로 완전한 룰 DSL은 이 규모(업적 ~20개, 룰이 카운터 수준)에 과하고 디버깅·테스트가 어렵다. 하이브리드는 룰 종류는 코드로 명확히, 튜닝 파라미터는 데이터로 유연하게 가져간다.
>
> **기각된 대안(Rejected)**: 순수 하드코딩 — 파라미터 변경마다 배포. 룰 DSL/규칙 엔진 — 이 규모에 과설계, 안전성·가독성 저하.

### 4.2 user_achievements — 유저별 업적 진행

```sql
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
```

### 4.3 xp_events — XP 원장(ledger). 진실의 원천

```sql
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
```

> **결정(Decision) — xp_events는 append-only 원장**: 모든 XP 적립을 개별 이벤트로 남긴다. `user_stats.total_xp`는 이 원장의 합계 캐시에 불과하다.
>
> **근거(Why)**: 원장이 있으면 `total_xp`가 어떤 이유(세션/업적/연속보너스)로 쌓였는지 완전 추적되고, 캐시가 틀어져도 `SUM(xp_events)`로 **재대사(재계산)**할 수 있다. 감사·디버깅·롤백의 근거가 된다.
>
> **기각된 대안(Rejected)**: `user_stats.total_xp`만 증분 저장 — 오류 발생 시 어디서 틀어졌는지 추적 불가, 재계산 불가능.

### 4.4 user_stats — 의도적 반정규화 캐시

```sql
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
  updated_at        timestamptz NOT NULL DEFAULT now()
);
```

> **결정(Decision) — user_stats는 의도적 반정규화 캐시 + 야간 정합성 배치**: 매 요청마다 XP 합계·streak를 재계산하지 않도록 집계 결과를 캐시한다. 대신 야간 배치로 `total_xp == SUM(xp_events)` 정합성을 검증·교정한다.
>
> **근거(Why)**: 프로필/홈 화면은 total_xp·level·streak를 매번 읽는다. 매 요청 `SUM`/streak 스캔은 낭비다. 원장(`xp_events`)이 진실이므로 캐시가 틀어져도 배치로 복구 가능 — 반정규화의 위험(불일치)을 원장 + 배치로 흡수한다.
>
> **기각된 대안(Rejected)**: 매 요청 실시간 집계 — 불필요한 반복 계산. 캐시만 두고 정합성 검증 없음 — 드리프트 누적 시 진실 상실.

---

## 5. B2B 선반영 (기능은 Stage 3)

테이블만 지금 만들고 기능은 나중에 켠다. 상세 설명·플로우는 [07-b2b-extension.md](./07-b2b-extension.md).

```sql
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text CHECK (type IN ('hospital','rehab_center','clinic','other')),
  biz_reg_no text,                                   -- 사업자등록번호
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
  consent_at        timestamptz,                     -- 환자 동의 시각. NULL이면 열람 불가
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
```

> **결정(Decision) — care_relations.consent_at이 열람 게이트**: 치료사는 `status='active'` **그리고** `consent_at IS NOT NULL`인 관계를 통해서만 환자 데이터를 열람한다.
>
> **근거(Why)**: 환자 명시 동의 없는 건강정보 열람은 개인정보보호법 위반이다. 동의를 컬럼 하나로 물화해 인가 로직과 감사 로그가 이 값을 강제로 참조하게 한다([06](./06-security-compliance.md)).
>
> **기각된 대안(Rejected)**: 관계 존재만으로 열람 허용 — 동의 없는 열람 발생, 법적 리스크.

---

## 6. 정규화 판단 요약

- **기본 3NF**를 따른다. 각 사실은 한 곳에만 저장한다.
- **의도적 반정규화 2곳**:
  1. `sessions` — 세트 집계 요약(`avg_force`, `max_force`, `stars`)을 세션 로우에 저장. **write-once/read-many** 특성이라 재집계보다 저장이 유리.
  2. `user_stats` — `total_xp`, `level`, streak 등 매요청 재계산을 피하기 위한 캐시. **`xp_events` 원장으로 언제든 재대사 가능**하므로 안전.
- 반정규화의 위험(데이터 드리프트)은 **원장(`xp_events`) + 야간 정합성 배치**로 흡수한다.

---

## 7. 인덱스 DDL

```sql
-- 세션 목록: 유저별 최신순 조회(GET /users/me/sessions)
CREATE INDEX idx_sessions_user_started
  ON sessions (user_id, started_at DESC);

-- 멱등 제약(테이블 정의에 포함, 재확인):
-- CONSTRAINT uq_sessions_idem UNIQUE (user_id, client_session_id)

-- XP 원장: 최근 적립 내역(GET /users/me/xp-events)
CREATE INDEX idx_xp_events_user_created
  ON xp_events (user_id, created_at DESC);

-- 리더보드: total_xp 내림차순. 수천 명까지 충분. 이후 Redis Sorted Set으로 이관
CREATE INDEX idx_user_stats_total_xp
  ON user_stats (total_xp DESC);

-- 캘리브레이션 최신 1건 조회
CREATE INDEX idx_calibrations_user_latest
  ON calibrations (user_id, calibrated_at DESC);

-- B2B: 활성 관계만 부분 인덱스 (치료사→환자, 환자→치료사)
CREATE INDEX idx_care_therapist
  ON care_relations (therapist_user_id) WHERE status = 'active';
CREATE INDEX idx_care_patient
  ON care_relations (patient_user_id) WHERE status = 'active';
```

> **결정(Decision) — 리더보드는 당분간 `idx_user_stats_total_xp`로**: 별도 리더보드 인프라 없이 인덱스 스캔으로 순위를 낸다.
>
> **근거(Why)**: 수천 명 규모에서 `ORDER BY total_xp DESC LIMIT n`은 인덱스로 밀리초에 끝난다. Redis Sorted Set은 리더보드 출시·규모 확대 시([05](./05-scaling-roadmap.md) Stage 1) 도입한다.
>
> **기각된 대안(Rejected)**: 처음부터 Redis ZSET — 초기 규모에 운영 복잡도만 추가.

---

## 8. 파티셔닝 판단

**파티셔닝은 하지 않는다.** 10만 유저의 3년치 세션도 수억 행 미만이고(유저당 일 1~3건), 실제 규모 가정은 수천 명이다. 단일 테이블 + 적절한 인덱스로 충분하다.

> 월별 파티셔닝은 `sessions`가 **수천만 행을 초과할 때 재검토**한다. (그 전에는 복잡도만 늘 뿐 이득 없음.)

---

## 9. ERD (mermaid)

```mermaid
erDiagram
    users ||--|| profiles : has
    users ||--|| user_settings : has
    users ||--|| user_stats : has
    users ||--o{ sessions : records
    users ||--o{ calibrations : has
    users ||--o{ xp_events : earns
    users ||--o{ user_achievements : progresses
    users ||--o{ devices : owns

    sessions ||--o{ session_sets : contains
    sessions }o--o| calibrations : "measured with"
    sessions }o--o| devices : "used"

    achievement_definitions ||--o{ user_achievements : defines

    organizations ||--o{ org_members : has
    organizations ||--o{ devices : owns
    users ||--o{ org_members : "member of"
    users ||--o{ care_relations : "therapist/patient"
    care_relations ||--o{ prescriptions : issues

    users {
        uuid id PK
        citext email UK
        text password_hash
        text role
        text status
        timestamptz deleted_at
    }
    profiles {
        uuid user_id PK_FK
        text name
        date birth_date
        bytea phone_enc
        text injury_type
        smallint goal_force
        text avatar_url
    }
    sessions {
        uuid id PK
        uuid client_session_id
        uuid user_id FK
        text exercise_type
        timestamptz started_at
        int duration_sec
        numeric avg_force
        numeric max_force
        smallint stars
        jsonb force_series
    }
    session_sets {
        bigint id PK
        uuid session_id FK
        smallint set_index
        numeric peak_force
    }
    xp_events {
        bigint id PK
        uuid user_id FK
        int amount
        text reason
    }
    user_stats {
        uuid user_id PK
        int total_xp
        smallint level
        text tier
        int current_streak
    }
    achievement_definitions {
        text id PK
        text rule_type
        jsonb rule_params
        int reward_xp
    }
    user_achievements {
        uuid user_id PK_FK
        text achievement_id PK_FK
        int progress
        timestamptz unlocked_at
    }
    calibrations {
        bigint id PK
        uuid user_id FK
        real baseline_raw_0
        real baseline_raw_100
    }
    care_relations {
        uuid id PK
        uuid therapist_user_id FK
        uuid patient_user_id FK
        text status
        timestamptz consent_at
    }
    prescriptions {
        uuid id PK
        uuid care_relation_id FK
        text exercise_type
        smallint target_force
    }
```
