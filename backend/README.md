# ReGrip 백엔드 (MVP)

손 재활 게이미피케이션 플랫폼 ReGrip 의 백엔드 API. **"서버가 진실을 계산한다"** 원칙 위에서
별점·XP·레벨·업적을 서버가 재계산하고, 세션 저장은 `clientSessionId` 멱등키로 중복을 방지한다.

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
# 개발 서버 (자동 리로드). 기본 DB 는 sqlite:///./regrip_dev.db
uvicorn src.main:app --reload

# 헬스체크
curl http://127.0.0.1:8000/health          # {"status":"ok"}
# Swagger UI
start http://127.0.0.1:8000/docs
```

앱 startup 시 SQLite 테이블 자동 생성 + 업적 6종 자동 upsert 된다. 수동 시딩이 필요하면:

```powershell
python -m scripts.seed_achievements
```

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
> `migrations/001_init.sql` 은 `src/models` 의 SQLAlchemy 모델과 **수동으로 정렬**되어 있다.
> 스키마를 바꾸면 두 곳을 함께 고쳐야 한다.

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
- **별점 서버 재계산**: balloon `[5,10]`, crane `[4,8]` 임계. 클라 `stars` 무시.
- **세션 XP** = `min(50 + score*2, 150) + (별3 +50 / 별2 +20)`.
- **7일 연속 보너스** = `+200`, streak run 당 1회.
- **totalXp = Σ xp_events** (원장 불변식). `level = 100+(L-1)*25` 누적, 티어 6종.
- **멱등성**: `UNIQUE(user_id, client_session_id)`. 중복 제출은 **200 + 최초 결과**(`sessions.result_snapshot`), XP 재적립 없음.

### 업적 6종 (프론트 GamificationEngine 과 동일 id/타이틀/XP)
`first_pop`(100) · `first_capsule`(100) · `three_star`(150) · `strong_grip`(200, 최대악력 80↑ 5회) ·
`consistency_king`(300, 7일 연속) · `halfway_goal`(500, 크레인 누적 세트 500).

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
