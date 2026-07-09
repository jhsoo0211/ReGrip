# 02. REST API 스펙

> **한 줄 요약**: `/api/v1` 프리픽스, JWT(Access 30분 + Refresh 14일 회전) 인증, `camelCase` 필드 유지(프론트 `DataService` 호환), 세션 POST 응답에 게이미피케이션 결과를 동봉한다. `avatarBase64` 과도기 호환을 서버가 흡수한다.

## 관련 문서
- 데이터 모델: [01-erd.md](./01-erd.md)
- 세션 POST의 계산·트랜잭션: [03-gamification-engine.md](./03-gamification-engine.md)
- 인증/암호화/동의 근거: [06-security-compliance.md](./06-security-compliance.md)
- 센서 데이터 업로드 경계: [04-sensor-data-policy.md](./04-sensor-data-policy.md)
- B2B 엔드포인트 인가: [07-b2b-extension.md](./07-b2b-extension.md)

---

## 1. 공통 규약

### 1.1 URL 버전링

- 모든 엔드포인트는 **`/api/v1`** 프리픽스를 가진다.

> **결정(Decision)**: URL 경로 버전링(`/api/v1`)을 채택한다.
>
> **근거(Why)**: 경로 버전은 캐시·라우팅·디버깅이 직관적이고 브라우저 주소창에서 바로 보인다. 이 규모에서 헤더 기반 콘텐츠 협상 버전링은 오버헤드만 크다.
>
> **기각된 대안(Rejected)**: `Accept: application/vnd.regrip.v1+json` 헤더 버전링 — 툴링·디버깅 복잡, 이득 없음.

### 1.2 필드 네이밍 — camelCase 유지

- API 요청/응답 필드는 **`camelCase`**(`durationMin`, `avgForce`, `clientSessionId`). DB는 `snake_case`. **변환은 서버 내부**에서 한다.

> **결정(Decision)**: API는 camelCase, DB는 snake_case, 경계에서 서버가 변환.
>
> **근거(Why)**: 프론트 `DataService`가 이미 `durationMin`/`avgForce` 같은 camelCase를 쓴다. 이 계약을 유지해야 프론트 무수정 전환에 가깝다. DB 컨벤션(snake_case)과는 별개.
>
> **기각된 대안(Rejected)**: DB 필드명 그대로 노출 — 프론트 대량 수정 유발.

### 1.3 에러 규약

모든 에러는 아래 형태다.

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "avgForce must be <= maxForce", "details": { "field": "avgForce" } } }
```

**HTTP 상태 카탈로그 (부록)**

| 상태 | code 예시 | 의미 |
|------|-----------|------|
| 400 | `BAD_REQUEST` | 요청 형식 오류(파싱 불가 등) |
| 401 | `UNAUTHENTICATED` | 토큰 없음/만료 |
| 403 | `FORBIDDEN` | 권한 없음(동의 없는 환자 열람 등) |
| 404 | `NOT_FOUND` | 리소스 없음 |
| 409 | `CONFLICT` | 이메일 중복 등 (세션 멱등 중복은 409 아님 — §4.2) |
| 422 | `VALIDATION_FAILED` | 도메인 검증 실패(값 모순) |
| 429 | `RATE_LIMITED` | 요청 한도 초과 |

---

## 2. 인증

### 2.1 토큰 전략

- **Access JWT**: 30분. 페이로드 `{sub: userId, role}`. `Authorization: Bearer <token>`.
- **Refresh 토큰**: 14일, **회전(rotation)**. `httpOnly; Secure; SameSite=Strict` 쿠키. `refresh_tokens` 테이블에 저장(해시)해 폐기·재사용 탐지.

> **결정(Decision)**: 짧은 Access JWT + 회전형 Refresh 쿠키. Refresh는 DB 저장.
>
> **근거(Why)**: Access는 무상태로 검증(스케일 용이), 탈취 시 노출 창은 30분. Refresh를 회전+DB 저장하면 탈취·재사용을 탐지하고 즉시 폐기할 수 있다. httpOnly 쿠키로 XSS로부터 Refresh를 보호.
>
> **기각된 대안(Rejected)**: 장수명 Access 단일 토큰 — 탈취 시 폐기 불가. Refresh를 localStorage 보관 — XSS 취약.

### 2.2 refresh_tokens 테이블

```sql
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,          -- 원문 아님(해시 저장)
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,                    -- 회전 체인 추적
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
```

### 2.3 인증 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/v1/auth/signup` | 회원가입 (동의 항목 포함) |
| POST | `/api/v1/auth/login` | 로그인 → Access 반환 + Refresh 쿠키 설정 |
| POST | `/api/v1/auth/refresh` | Refresh 쿠키로 새 Access 발급(+ Refresh 회전) |
| POST | `/api/v1/auth/logout` | Refresh 폐기 + 쿠키 삭제 |

**POST /auth/signup 요청**
```json
{
  "email": "patient@example.com",
  "password": "••••••••",
  "profile": { "name": "홍길동", "birthDate": "1980-05-01" },
  "consents": {
    "sensitiveData": true,
    "sensitiveDataAt": "2026-07-09T02:00:00Z",
    "termsOfService": true,
    "guardianConsent": null
  }
}
```
> `consents.sensitiveData`는 민감정보(건강정보) 처리 동의다. 미동의 시 422. 만 14세 미만이면 `guardianConsent` 필수([06](./06-security-compliance.md)).

**POST /auth/login 응답**
```json
{ "accessToken": "eyJ...", "expiresIn": 1800, "user": { "id": "u-uuid", "email": "patient@example.com", "role": "patient" } }
```
Refresh 토큰은 응답 본문이 아니라 `Set-Cookie`로 내려간다.

---

## 3. 프로필 / 설정

### 3.1 GET /api/v1/users/me/profile

```json
{
  "name": "홍길동",
  "age": 45,
  "birthDate": "1980-05-01",
  "gender": "male",
  "phone": "010-1234-5678",
  "hand": "right",
  "injuryType": "tendon",
  "treatmentStart": "2026-06-01",
  "doctorName": "김의사",
  "goalForce": 60,
  "goalDays": 5,
  "avatarUrl": "https://cdn.regrip.app/avatars/u-uuid.webp"
}
```
- `age`는 서버가 `birthDate`에서 유도해 응답(하위 호환 위해 함께 제공).
- `phone`은 서버가 복호화해 응답(전송 구간은 TLS).

### 3.2 PUT /api/v1/users/me/profile — avatarBase64 과도기 호환

프론트가 아직 `avatarBase64`(data URL)를 보내는 과도기를 서버가 흡수한다.

**요청 (프론트 무수정 케이스)**
```json
{ "name": "홍길동", "goalForce": 60, "avatarBase64": "data:image/png;base64,iVBORw0KG..." }
```

서버 처리: `avatarBase64`가 오면 **디코드 → 오브젝트 스토리지 업로드 → `avatar_url` 치환** 후 저장하고, 응답은 `avatarUrl`로 준다.

> **결정(Decision)**: PUT에서 `avatarBase64`가 오면 서버가 디코드·업로드해 `avatar_url`로 바꿔 저장한다. 프론트는 수정하지 않아도 동작한다.
>
> **근거(Why)**: 프론트 무수정 전환이 마이그레이션 리스크를 낮춘다. 서버가 과도기 변환을 떠맡아 base64를 DB에 넣지 않는다([01](./01-erd.md) profiles 결정).
>
> **기각된 대안(Rejected)**: 프론트를 먼저 고쳐 multipart만 받기 — 프론트/백 동시 배포 강제, 전환 리스크 증가.

### 3.3 POST /api/v1/users/me/avatar (multipart)

향후 프론트 정식 경로. `multipart/form-data`로 이미지 파일 업로드 → `{ "avatarUrl": "..." }`.

### 3.4 GET / PUT /api/v1/users/me/settings

```json
{ "hand": "right", "difficulty": "normal", "restSeconds": 30,
  "reminderEnabled": true, "reminderTime": "09:00", "sessionSummaryEnabled": true }
```

---

## 4. 세션

### 4.1 GET /api/v1/users/me/sessions — 커서 페이지네이션

쿼리: `?from=2026-06-01&to=2026-07-09&cursor=<opaque>&limit=20`

```json
{
  "data": [
    { "id": "s-uuid", "clientSessionId": "cs-uuid", "date": "2026-07-08T10:00:00Z",
      "exerciseType": "game_balloon", "label": "풍선 게임",
      "durationMin": 12, "sets": 10, "avgForce": 42.5, "maxForce": 68.0, "stars": 3 }
  ],
  "meta": { "nextCursor": "eyJzdGFydGVkQXQiOiI...", "limit": 20 }
}
```
- `label`은 서버가 `exerciseType`에서 유도. `durationMin`은 `duration_sec`에서 유도(하위 호환).

> **결정(Decision)**: 오프셋이 아니라 **커서 페이지네이션**(`started_at` + `id` 복합 커서).
>
> **근거(Why)**: 세션은 최신순 무한 스크롤이 자연스럽고, 새 세션이 계속 추가돼 오프셋은 페이지 밀림(drift)이 생긴다. `(started_at DESC, id)` 커서는 `idx_sessions_user_started` 인덱스와 정확히 맞아 안정적·효율적이다.
>
> **기각된 대안(Rejected)**: `OFFSET/LIMIT` — 삽입으로 인한 중복/누락, 깊은 페이지 성능 저하.

### 4.2 POST /api/v1/users/me/sessions — 게이미피케이션 결과 동봉

**요청 (clientSessionId 필수)**
```json
{
  "clientSessionId": "cs-uuid-1234",
  "exerciseType": "game_balloon",
  "startedAt": "2026-07-09T01:30:00Z",
  "durationSec": 720,
  "score": 10,
  "avgForce": 42.5,
  "maxForce": 68.0,
  "attempts": 3,
  "difficulty": "normal",
  "handUsed": "right",
  "deviceId": "d-uuid",
  "sets": [
    { "setIndex": 0, "reps": 5, "avgForce": 40.0, "peakForce": 62.0, "holdSec": 8 }
  ]
}
```
- `sets`는 **optional**([01](./01-erd.md) session_sets 주의 참조).
- `stars`는 보내도 무시된다 — 서버가 재계산([03](./03-gamification-engine.md)).

**응답 (201, 신규 적립)**
```json
{
  "session": { "id": "s-uuid", "exerciseType": "game_balloon", "label": "풍선 게임",
    "durationMin": 12, "sets": 10, "avgForce": 42.5, "maxForce": 68.0, "stars": 3 },
  "xpAwarded": 120,
  "totalXp": 3420,
  "level": 14,
  "levelUp": true,
  "unlockedAchievements": [
    { "id": "force_60", "title": "악력 60 돌파", "rewardXp": 200, "rarity": "rare" }
  ]
}
```

> **결정(Decision) — 멱등 중복은 200 + 기존 결과, 409 아님**: 같은 `(userId, clientSessionId)` 재요청은 새 XP를 적립하지 않고 **기존 세션의 결과를 200으로** 반환한다.
>
> **근거(Why)**: 오프라인 큐 재전송·네트워크 재시도를 안전하게 만드는 핵심(원칙 ②). 409를 주면 클라가 에러로 처리해 재시도 루프에 빠질 수 있다. 200 + 기존 결과가 "이미 처리됨"을 매끄럽게 전달한다. XP 이중 적립은 절대 금지.
>
> **기각된 대안(Rejected)**: 409 Conflict 반환 — 정당한 재전송을 에러로 오인. 무조건 새 세션 생성 — XP 중복 적립.

> **결정(Decision) — 응답에 게이미피케이션 결과 동봉**: 세션 저장 응답에 `xpAwarded`/`totalXp`/`level`/`levelUp`/`unlockedAchievements`를 함께 준다.
>
> **근거(Why)**: 세션 종료 직후 "XP 획득/레벨업/업적 달성" 연출을 하려면 클라가 추가 호출 없이 즉시 결과를 알아야 한다. 동기 계산이므로([03](./03-gamification-engine.md)) 자연스럽게 한 응답에 담긴다.
>
> **기각된 대안(Rejected)**: 세션 저장 후 클라가 stats/achievements를 재조회 — 왕복 추가, 연출 타이밍 어긋남.

### 4.3 GET /api/v1/users/me/sessions/{id} — 세트 상세 포함

```json
{
  "id": "s-uuid", "exerciseType": "game_balloon", "label": "풍선 게임",
  "startedAt": "2026-07-09T01:30:00Z", "durationMin": 12,
  "avgForce": 42.5, "maxForce": 68.0, "stars": 3,
  "forceSeries": [40, 42, 45, 41, 38],
  "sets": [ { "setIndex": 0, "reps": 5, "avgForce": 40.0, "peakForce": 62.0, "holdSec": 8 } ]
}
```

---

## 5. 통계 / 게이미피케이션 조회

### 5.1 GET /api/v1/users/me/stats?range=7d — 클라 계산의 서버 이동

```json
{
  "totalXp": 3420, "level": 14, "tier": "apprentice",
  "currentStreak": 5, "longestStreak": 12,
  "totalSessions": 47, "bestMaxForce": 72.0,
  "chart": [
    { "date": "2026-07-03", "sessions": 1, "avgForce": 40.0 },
    { "date": "2026-07-04", "sessions": 0, "avgForce": null }
  ]
}
```
> streak·7일 차트는 기존에 클라가 계산하던 것을 서버로 옮긴 것이다(원칙 ①과 일관).

### 5.2 GET /api/v1/achievements + GET /api/v1/users/me/achievements

- `/achievements`: 전체 업적 정의 목록(표시 순서 포함).
- `/users/me/achievements`: 내 진행 상태.

```json
{ "data": [
  { "id": "streak_7", "title": "7일 연속", "description": "7일 연속 훈련",
    "category": "persistence", "rarity": "epic", "rewardXp": 300,
    "progress": 5, "target": 7, "progressLabel": "5/7일", "unlockedAt": null }
] }
```

### 5.3 GET /api/v1/users/me/xp-events?limit=10

```json
{ "data": [
  { "amount": 120, "reason": "session", "refType": "session", "refId": "s-uuid", "createdAt": "2026-07-09T01:42:00Z" },
  { "amount": 200, "reason": "streak_bonus", "createdAt": "2026-07-08T10:00:00Z" }
] }
```

### 5.4 캘리브레이션

- **POST /api/v1/users/me/calibrations** (이력 append)
```json
{ "deviceId": "d-uuid", "baselineRaw0": 512.0, "baselineRaw100": 890.0 }
```
- **GET /api/v1/users/me/calibrations/latest** → 최신 1건.

### 5.5 GET /api/v1/leaderboard?scope=weekly (Stage 1)

익명화 원칙. 실명 대신 닉네임/이니셜.
```json
{ "scope": "weekly", "data": [
  { "rank": 1, "displayName": "R***", "totalXp": 5200, "level": 21, "isMe": false }
] }
```
> 리더보드는 [05](./05-scaling-roadmap.md) Stage 1 기능. 익명화는 [06](./06-security-compliance.md).

---

## 6. B2B 엔드포인트 (Stage 3)

치료사는 `care_relations`가 **`active` + `consent_at IS NOT NULL`**인 환자만 인가된다. 위반 시 403 + `audit_logs` 기록([07](./07-b2b-extension.md)).

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/v1/orgs/{orgId}/patients` | 담당 환자 목록(동의된 관계만) |
| GET | `/api/v1/orgs/{orgId}/patients/{userId}/sessions` | 환자 세션 추이 |
| POST | `/api/v1/orgs/{orgId}/prescriptions` | 처방 생성 |

**POST /orgs/{orgId}/prescriptions 요청**
```json
{ "careRelationId": "cr-uuid", "exerciseType": "full_grip",
  "targetForce": 55, "sets": 3, "reps": 10, "daysPerWeek": 5,
  "validFrom": "2026-07-10", "validTo": "2026-08-10", "note": "무리하지 말 것" }
```

---

## 7. DataService 마이그레이션 노트

프론트 `shared.js`의 `DataService`를 최소 수정으로 전환하기 위한 지침.

1. **fetch 래퍼에 Authorization 주입**: 모든 요청에 `Authorization: Bearer <accessToken>` 헤더 추가. Refresh 쿠키는 `credentials: 'include'`로 자동 전송.
2. **경로 매핑**:
   | 기존 | 신규 |
   |------|------|
   | `GET /api/profile` | `GET /api/v1/users/me/profile` |
   | `PUT /api/profile` | `PUT /api/v1/users/me/profile` |
   | `GET /api/sessions` | `GET /api/v1/users/me/sessions` |
   | `POST /api/sessions` | `POST /api/v1/users/me/sessions` |
3. **clientSessionId 발급**: 로컬 모드에서 쓰던 `id = Date.now()` 대신, 세션 생성 시 `crypto.randomUUID()`로 `clientSessionId`를 만들어 POST에 실어 보낸다(멱등키).
4. **401 처리**: 401 응답 시 `POST /auth/refresh`로 Access 재발급 후 **원 요청을 1회 재시도**. 재시도도 401이면 로그인 화면으로.
5. **필드 호환**: 응답이 `durationMin`/`avgForce`/`label`을 그대로 주므로 기존 렌더링 코드는 유지된다. 추가 필드(`stars` 서버값, `xpAwarded` 등)만 활용.
