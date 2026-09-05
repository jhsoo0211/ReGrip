# ReGrip 백엔드 (MVP)

손 재활 게이미피케이션 플랫폼 ReGrip 의 백엔드 API.
클라이언트가 제출한 게임 결과로 별점·XP·레벨·업적을 서버가 재계산하고,
세션 저장은 `clientSessionId` 멱등키로 중복을 방지한다. 센서 측정 자체를 서버가 인증하는 구조는 아니다.

- 스택: Python 3.11 · FastAPI · SQLAlchemy 2.x(sync) · Pydantic v2(camelCase) · argon2id · PyJWT
- DB: 개발/테스트 = SQLite, 운영 = PostgreSQL (`DATABASE_URL` 하나로 전환)
- 설계 원천: `../docs/backend/00~03,06`. 이 코드는 그 설계서를 구현한 것이다.

---

## 1. 설치 (Windows PowerShell)

```powershell
cd backend

# 3.11 가상환경 생성 & 활성화
py -3.11 -m venv venv
.\venv\Scripts\Activate.ps1

# 의존성 설치
pip install -r requirements.txt

# 환경변수 파일 준비 (선택 — 없으면 개발 기본값으로 동작)
Copy-Item .env.example .env
```

> 활성화 스크립트 실행이 정책으로 막히면:
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` 후 다시 `Activate.ps1`.

## 2. 실행

```powershell
# 개발 서버 (자동 리로드). 기본 DB 는 sqlite:///./regrip_dev.db, 기본 ENV 는 dev
uvicorn src.main:app --reload

# 헬스체크
curl http://127.0.0.1:8000/health          # {"status":"ok"}
# Swagger UI
start http://127.0.0.1:8000/docs
```

> ⚠️ **`RuntimeError: 운영 환경(ENV=prod) 설정 검증에 실패…` 로 기동이 막히면** 쉘/환경변수에
> `ENV=prod` 가 설정돼 있는 것이다. 이 fail-fast 가드는 **운영 배포에서만** 동작하며, 기본 시크릿·SQLite
> 로는 뜨지 않게 막는다(의도된 안전장치). **로컬 개발은 `ENV=dev`(기본값)로 실행**하면 된다:
> ```powershell
> echo $env:ENV                    # prod 로 남아 있으면
> $env:ENV = "dev"                 # dev 로 바꾸거나
> Remove-Item Env:\ENV             # 아예 제거(기본 dev)
> uvicorn src.main:app --reload
> ```
> 진짜 운영이라면 가드 메시지대로 `JWT_SECRET`(32자+)·`PHONE_ENC_KEY`(32B base64url)·PostgreSQL
> `DATABASE_URL` 을 `.env` 에 설정한다(§4).

앱 startup 시 SQLite 테이블 자동 생성 + 업적 8종 자동 upsert 된다. 수동 시딩이 필요하면:

```powershell
python -m scripts.seed_achievements
```

`create_all`은 기존 테이블에 컬럼을 추가하지 않는다. 기존 SQLite DB에 세션 출처 컬럼이 없으면
기동 시 업그레이드 안내와 함께 중단한다. **기존 DB를 삭제하지 말고**, API를 중지한 뒤 다음을 실행한다:

```powershell
.\venv\Scripts\python.exe -m scripts.upgrade_sqlite --database .\regrip_dev.db --dry-run
.\venv\Scripts\python.exe -m scripts.upgrade_sqlite --database .\regrip_dev.db
```

이 명령은 SQLite backup API로 WAL의 커밋된 데이터까지 `.backups`에 백업하고, 트랜잭션으로
`input_source`와 `calibration_snapshot` 중 없는 컬럼만 추가한다. 재실행은 변경 없이 종료한다.
이전 기록은 `unknown`이며 XP·보상·점수는 수정하지 않는다. 실패하면 DDL을 롤백하고 백업 경로를 안내한다.
이 도구의 범위는 004의 두 컬럼 추가이며, 이전 버전의 다른 스키마 차이를 자동 수정하지 않는다.

## 3. 테스트

```powershell
.\venv\Scripts\python.exe -m pytest tests/ -q
```

테스트는 in-memory SQLite + FastAPI `TestClient` 로 실제 HTTP 왕복을 검증한다(실 DB 파일 불필요).

## 4. PostgreSQL 전환 (운영)

1. PostgreSQL 15+ 를 준비하고 `pgcrypto`/`citext` 확장을 쓸 수 있어야 한다.
2. 스키마를 마이그레이션으로 생성한다(운영은 ORM 자동생성이 아니라 이 SQL 이 진실):

   ```powershell
   psql "$env:DATABASE_URL" -f migrations/001_init.sql
   psql "$env:DATABASE_URL" -f migrations/002_game_types.sql
   psql "$env:DATABASE_URL" -f migrations/003_signal_catalog.sql
   psql "$env:DATABASE_URL" -f migrations/004_session_provenance.sql
   ```

3. PostgreSQL 드라이버를 설치한다(psycopg 3 권장):

   ```powershell
   pip install "psycopg[binary]"
   ```

4. `.env` 의 `DATABASE_URL` 을 PostgreSQL DSN 으로 바꾼다:

   ```
   DATABASE_URL=postgresql+psycopg://user:password@host:5432/regrip
   ENV=prod
   JWT_SECRET=<길고 무작위한 값>
   PHONE_ENC_KEY=<32바이트 base64url 키>
   ```

5. 업적 시딩:

   ```powershell
   python -m scripts.seed_achievements
   ```

> 운영에서는 `ENV=prod` 일 때만 Refresh 쿠키에 `Secure` 플래그가 붙는다(HTTPS 필수).
> `migrations/*.sql`과 ORM 모델은 수동으로 정렬한다. 기존 DB에는 아직 적용하지 않은 마이그레이션만
> 순서대로 적용한다. 002는 이전 CHECK를 제거한 뒤 `normal`을 `medium`으로 변환한다.

---

## 5. 아키텍처 개요

```
src/
├── main.py            # FastAPI 앱, /api/v1 라우터, CORS, 에러 envelope, StaticFiles, startup 시드
├── core/              # config(.env) · db(engine/session) · types(uuid/jsonb/citext 폴백)
│                      #   security(argon2/JWT/refresh) · crypto(전화번호 AES-GCM) · errors · timeutil
├── models/            # SQLAlchemy: users/profiles/user_settings/devices/calibrations/sessions/
│                      #   session_sets/achievement_definitions/user_achievements/xp_events/
│                      #   user_stats/refresh_tokens
├── schemas/           # Pydantic v2 (camelCase alias)
├── services/          # gamification(순수 계산) · achievements(시드+판정) · session_service(트랜잭션)
│                      #   labels · storage(아바타)
└── api/               # auth · profile · settings · sessions · stats · achievements · xp_events
                       #   calibrations · health
```

### 게이미피케이션 핵심 (03 문서)
- **별점 서버 재계산**: balloon `[5,10]`, crane `[3,5]`, rhythm `[14,20]`, glide `[15,24]`. 클라 `stars` 무시.
- **세션 XP** = `min(50 + score*2, 150) + (별3 +50 / 별2 +20)`.
- **7일 연속 보너스** = `+200`, streak run 당 1회.
- **totalXp = Σ xp_events** (원장 불변식). `level = 100+(L-1)*25` 누적, 티어 6종.
- **멱등성**: `UNIQUE(user_id, client_session_id)`. 중복 제출은 **200 + 최초 결과**(`sessions.result_snapshot`), XP 재적립 없음.

### 업적 8종 (프론트 GamificationEngine 과 동일 id/타이틀/XP)
`first_pop`(100) · `first_capsule`(100) · `three_star`(150) · `strong_grip`(200, 최대악력 80↑ 5회) ·
`consistency_king`(300, 7일 연속) · `halfway_goal`(500, 크레인 누적 세트 500) ·
`first_rhythm`(100, 리듬 펌프 첫 세션) · `first_glide`(100, 잠수함 첫 항해).

---

## 6. 엔드포인트 (전부 `/api/v1`)

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/auth/signup` | 회원가입(동의 항목 검증, 만14세 미만 법정대리인 동의) |
| POST | `/auth/login` | 로그인 → accessToken + refresh 쿠키 |
| POST | `/auth/refresh` | refresh 회전(재사용 탐지 시 401) |
| POST | `/auth/logout` | refresh 폐기 + 쿠키 삭제 |
| GET/PUT | `/users/me/profile` | 프로필(age 유도, phone 복호화, avatarBase64 과도기 호환) |
| POST | `/users/me/avatar` | 아바타 multipart 업로드 |
| GET | `/users/me/sessions` | 세션 목록(커서 페이지네이션, `from/to/cursor/limit`) |
| POST | `/users/me/sessions` | 세션 저장 + 게이미피케이션 결과 동봉(멱등) |
| GET | `/users/me/sessions/{id}` | 세션 상세(세트 포함) |
| GET | `/users/me/stats` | streak/총계 + N일 차트(`range=7d`) |
| GET/PUT | `/users/me/settings` | 설정 |
| GET | `/achievements` | 업적 정의 전체 |
| GET | `/users/me/achievements` | 내 업적 진행 |
| GET | `/users/me/xp-events` | XP 원장 최근 내역(`limit=10`) |
| POST | `/users/me/calibrations` | 캘리브레이션 이력 append |
| GET | `/users/me/calibrations/latest` | 최신 캘리브레이션 |
| GET | `/health`, `/api/v1/health` | 헬스체크 |

에러는 전부 `{"error":{"code","message","details"}}` envelope. 검증 실패는 422 `VALIDATION_FAILED`.

---

## 7. 프론트 연동 메모 (02 §7)
- 응답은 camelCase(`durationMin`/`avgForce`/`label`) 를 유지하므로 기존 `DataService` 렌더 코드가 거의 그대로 동작한다.
- 모든 요청에 `Authorization: Bearer <accessToken>`, refresh 는 쿠키(`credentials:'include'`).
- 세션 생성 시 `crypto.randomUUID()` 로 `clientSessionId` 발급(멱등키).
- 아바타는 `/static/avatars/...` URL 로 서빙(로컬). S3/presigned URL 전환은 추후.

## 8. 입력 출처와 BLE 보정 스냅샷

정규 세션 POST와 목록·상세 응답에 `inputSource`와 `calibrationSnapshot`이 추가된다.
`inputSource`는 `ble | websocket | simulation | unknown`이며 누락된 기존 클라이언트·기록은 `unknown`이다.
BLE 세션은 아래 스냅샷이 필수이고 다른 입력 출처의 스냅샷은 null이다.

```json
{
  "inputSource": "ble",
  "calibrationSnapshot": {
    "version": 2,
    "source": "ble",
    "unit": "adc_12bit",
    "channel": "fsr",
    "baseline0": 3000,
    "baseline100": 1000,
    "capturedAt": "2026-09-05T12:00:00Z"
  }
}
```

ADC는 증가·감소 방향을 모두 지원한다. 두 기준값은 유한한 0~4095이고 차이의 절댓값은 64 이상이어야 한다.
게임 시작 시 사용한 보정을 스냅샷으로 고정하고, 로컬 기록·아웃박스·재전송에서도 그대로 유지한다.
기존 `/calibrations` API는 레거시 보정용이며 BLE 보정은 사용자·장치별 로컬 캐시와 세션 스냅샷을 사용한다.
`avgForce`, `maxForce`, `forceSeries`는 ADC 원시값이 아닌 정규화된 0~100 값이다.

`GET /users/me/sessions`와 `GET /users/me/stats`는 `source=all|real|simulation|unknown`을 받는다.
API 기본값은 호환성을 위해 `all`이고, `real`은 `ble`과 `websocket`이다. 실제 측정 화면은 반드시 `source=real`을
명시한다. 통계의 `totalSessions`, `bestMaxForce`, `chart`는 선택한 출처만 포함한다. `totalXp`, 레벨, 티어,
streak는 전체 정규 세션 기준으로 유지하며, `allSessionCount`와 `sourceCounts`는 출처별 전체 기간 횟수를 제공한다.
측정이 없는 경우 `bestMaxForce`와 차트 평균은 null이다. 날짜 필터·차트는 사용자의 타임존 기준이다.

20초 연습은 프론트에서 세션 제출과 XP 계산을 하지 않는다. 시뮬레이션 정규 세션은 기록과 게임 보상에 포함하지만
실제 측정 통계에는 포함하지 않는다. 입력 출처 표시는 클라이언트가 사용한 입력 방식의 기록이며 실기 인증이 아니다.

공개 정적 파일은 `/static/avatars`로 제한한다. 연구 카탈로그 DB·학습 결과·신호 blob이 들어 있는
`storage`의 다른 경로는 API가 공개하지 않는다.
