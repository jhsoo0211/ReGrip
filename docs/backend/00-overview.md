# 00. ReGrip 백엔드/DB 설계 개요

> **한 줄 요약**: ReGrip 백엔드는 "서버가 진실을 계산한다"는 원칙 위에 세운 단일 모놀리식 API + PostgreSQL 구조이며, 이 문서 세트는 프로토타입(localStorage)에서 정식 백엔드로 넘어가기 위한 개발 착수 브리프다.

## 관련 문서

이 문서 세트는 아래 순서로 읽는 것을 권장한다.

| # | 문서 | 무엇을 다루나 |
|---|------|--------------|
| 00 | **[00-overview.md](./00-overview.md)** (현재 문서) | 배경, 프로토타입 구조, 규모 가정, 설계 원칙 4개 |
| 01 | [01-erd.md](./01-erd.md) | PostgreSQL 스키마 전체 DDL, 인덱스, 정규화 판단, ERD |
| 02 | [02-api-spec.md](./02-api-spec.md) | REST API 스펙, 인증, 에러 규약, 엔드포인트별 JSON 예시 |
| 03 | [03-gamification-engine.md](./03-gamification-engine.md) | XP/레벨/티어/별/업적 계산 규칙, 세션 저장 트랜잭션 |
| 04 | [04-sensor-data-policy.md](./04-sensor-data-policy.md) | 센서 실시간 데이터 처리 정책 (로컬 처리 vs 스트리밍) |
| 05 | [05-scaling-roadmap.md](./05-scaling-roadmap.md) | 단계적 확장 로드맵, 과설계 금지 목록 |
| 06 | [06-security-compliance.md](./06-security-compliance.md) | 개인정보보호법/의료법 준수, 암호화, 동의 |
| 07 | [07-b2b-extension.md](./07-b2b-extension.md) | B2B(병원/치료사) 확장 스키마와 동의 플로우 |

읽는 순서 권장: **00 → 01 → 02 → 03**이 핵심 축이다. 04는 01/02의 배경 결정, 05는 운영 로드맵, 06/07은 규제·확장 계층이다.

---

## 1. 배경

ReGrip은 손 재활을 게이미피케이션한 O2O(Online-to-Offline) 플랫폼이다.

- **오프라인**: FSR(Force Sensitive Resistor) 악력 센서를 **ESP32**(WiFi 내장 MCU)에 연결해, 무선(WiFi) 로컬 WebSocket(`ws://<esp32-ip>:8080`)으로 `{force: 0~100, timestamp}` 데이터를 약 20Hz로 브라우저에 흘려보낸다. 전송 계층 결정(무선 우선, BLE/유선 폴백)은 [04-sensor-data-policy.md](./04-sensor-data-policy.md) ADR-04-0 참조.
- **온라인**: 웹앱(현재 vanilla HTML 프로토타입)이 이 센서 값을 받아 게임(풍선/크레인 등)을 구동하고, 세션 결과를 기록한다.

현재 백엔드는 **존재하지 않는다.** 모든 상태는 브라우저 `localStorage`에 저장되고, 프론트의 `shared.js` 안에 있는 `DataService`가 데이터 접근을 추상화하고 있다. 이 `DataService`가 곧 REST 전환점이다.

### 현 프로토타입의 데이터 접근 구조

`DataService`는 이미 REST를 흉내 낸 인터페이스를 노출한다.

- `GET/PUT /api/profile`
- `GET/POST /api/sessions`
- 인증 없음
- 로컬 모드에서는 `id = Date.now()`를 **클라이언트가 생성**

즉, 프론트는 이미 "서버가 있다고 가정한" 형태로 짜여 있다. 백엔드는 이 계약을 **최대한 깨지 않으면서** 뒤를 채워 넣는 작업이다. (자세한 마이그레이션 노트는 [02-api-spec.md](./02-api-spec.md) 참조.)

### 현재 클라이언트가 다루는 실제 데이터

| 도메인 | 실물 필드 |
|--------|-----------|
| profile (11필드) | `name`, `age`(문자열), `gender`, `phone`, `hand`, `injuryType`, `treatmentStart`, `doctorName`, `goalForce`(문자열), `goalDays`, `avatarBase64`(data URL 통짜) |
| session | `id`, `date`(ISO), `label`('풍선 게임'\|'크레인 게임'), `durationMin`, `sets`(=score), `avgForce`, `maxForce`, `stars`(클라 계산) |
| settings | `hand`, `difficulty`, `restSeconds` |
| calibration | `baseline0`, `baseline100` |

> 이 프로토타입 데이터는 백엔드 스키마에서 **정규화·타입 승격·서버 계산으로 재설계**된다. 예: `age`(문자열) → `birth_date`(date, 나이는 유도값), `avatarBase64` → 오브젝트 스토리지 + `avatar_url`. 상세는 [01-erd.md](./01-erd.md).

---

## 2. 규모 가정 (현실적 추정)

설계 의사결정의 기준이 되는 규모 가정을 명시한다. **FSR 하드웨어 보급이 성장의 병목**이라는 점이 핵심이다. 소프트웨어가 아니라 물리적 센서 배포 속도가 유저 수를 결정한다.

| 시점 | 활성 유저 | 근거 |
|------|-----------|------|
| 초기 (런칭) | 수십 ~ 수백 명 | 센서 시제품 배포 규모 |
| 1년 (낙관) | 수천 명 | 하드웨어 양산·B2B 시설 도입 시 |
| 세션 쓰기 부하 | 유저당 일 1~3건 | 재활 훈련 특성상 하루 몇 회 |

**함의**: 쓰기 TPS는 극도로 낮다. 수천 명 × 하루 3건 = 하루 수천~수만 건, 초당으로는 1건 미만이다. 이 규모에서는 **단일 PostgreSQL 인스턴스가 3년치 데이터를 여유롭게 감당**한다. 마이크로서비스, Kafka, 샤딩 같은 대규모 인프라는 전부 과설계다. (근거는 [05-scaling-roadmap.md](./05-scaling-roadmap.md).)

**비즈니스 방향**: B2C(환자 개인)를 우선하고, B2B(병원/재활센터 치료사가 담당 환자를 모니터링·처방)로 확장한다. B2B 스키마는 **지금 테이블만 선반영**하되 기능은 Stage 3에서 켠다. ([07-b2b-extension.md](./07-b2b-extension.md).)

---

## 3. 설계 원칙 4개

이 네 원칙은 이후 모든 문서의 판단 기준이다.

### 원칙 ① 서버 계산 원칙 — 게임 결과는 서버가 재계산한다

`stars`, `XP`, `레벨`, `업적 달성` 등 **보상·성취와 관련된 모든 값은 클라이언트가 보낸 것을 신뢰하지 않고 서버가 재계산**한다. 클라이언트는 원자재(세션 요약: `avgForce`, `maxForce`, `score`, `duration`)만 제출하고, 서버가 규칙 엔진으로 별점과 XP를 산출한다.

> **결정(Decision)**: 별점/XP/레벨/업적은 서버 권위 계산으로 확정한다. 클라 계산값은 UX용 임시 표시로만 허용하고, DB에는 서버 재계산 결과만 저장한다.
>
> **근거(Why)**: 게이미피케이션에는 보상이 걸려 있어 치팅 유인이 생긴다(리더보드 순위, 업적). 클라 값을 그대로 저장하면 조작된 세션이 DB의 진실이 되어버린다. 서버가 동일 입력에서 결정적으로 재계산하면 일관성과 감사 가능성이 확보된다.
>
> **기각된 대안(Rejected)**: (a) 클라 계산값을 그대로 신뢰 — 조작에 무방비, 리더보드 신뢰 붕괴. (b) 완전한 서버 사이드 게임 시뮬레이션(모든 센서 프레임 검증) — FSR 원시 측정치 자체의 위변조는 어차피 완전 차단 불가([03-gamification-engine.md](./03-gamification-engine.md) 참조)하고, 이 규모에 스트리밍 검증 인프라는 낭비.

### 원칙 ② 멱등성 — 세션 제출은 clientSessionId로 중복 방지

세션 저장 요청은 **네트워크 재시도·오프라인 큐 재전송으로 중복 도달**할 수 있다. 클라이언트가 세션 생성 시점에 발급한 `clientSessionId`(UUID)를 멱등키로 사용해, 같은 키의 재요청은 **새로 적립하지 않고 기존 결과를 반환**한다.

> **결정(Decision)**: `sessions.client_session_id`에 `UNIQUE(user_id, client_session_id)` 제약. 중복 제출 시 409가 아니라 기존 세션 결과를 200으로 반환하고, XP는 **절대 재적립하지 않는다.**
>
> **근거(Why)**: 오프라인 내성이 재활 훈련 환경의 필수 요구다(센서-브라우저가 인터넷 없는 로컬망에서 훈련 → 나중에 요약 제출). 재전송으로 XP가 이중 적립되면 게이미피케이션 경제가 깨진다.
>
> **기각된 대안(Rejected)**: 서버 생성 ID만 신뢰 — 오프라인 큐 재전송을 안전하게 처리할 방법이 없음. 타임스탬프+유저 조합 dedup — 클럭 스큐/동시 세션에 취약.

### 원칙 ③ 단계적 확장 — 지금 필요한 것만 짓는다 (과설계 금지)

규모 가정(수십~수천 명)에 맞춰 **Stage 0는 단일 컨테이너 모놀리식 + managed PostgreSQL + 오브젝트 스토리지**로 시작한다. Redis, 읽기 복제본, 집계 배치, 시계열 DB는 **명시적 트리거(지표 임계치)에 도달했을 때만** 도입한다.

> **결정(Decision)**: 확장 요소는 각 Stage의 트리거 지표를 문서로 못 박고, 트리거 전에는 도입하지 않는다.
>
> **근거(Why)**: 초기 팀 규모와 유저 규모에서 과설계는 개발 속도·운영 비용을 갉아먹는다. 병목은 소프트웨어가 아니라 하드웨어 보급이다.
>
> **기각된 대안(Rejected)**: 처음부터 MSA/Kafka/K8s — 이 규모에 정당화 불가. 상세 목록과 근거는 [05-scaling-roadmap.md](./05-scaling-roadmap.md)의 "과설계 금지 목록".

### 원칙 ④ 민감정보 최소 수집 — 건강정보는 꼭 필요한 만큼만

재활 측정 데이터와 `injury_type`은 **개인정보보호법상 민감정보(건강정보)**다. 수집 항목을 최소화하고, 수집 시 별도 동의를 받고, 저장 시 암호화·접근 통제·감사 로그를 적용한다.

> **결정(Decision)**: 민감정보는 (a) 최소 수집, (b) 별도 동의(항목·목적·보유기간 고지), (c) 애플리케이션 레벨 암호화(전화번호 등), (d) 접근 감사 로그, (e) 탈퇴 시 soft delete + 파기 원칙으로 다룬다.
>
> **근거(Why)**: 건강정보 유출은 법적 책임과 신뢰 붕괴로 직결된다. 의료법상 진단·처방을 표방할 수 없으므로 "훈련 보조" 포지셔닝을 유지해야 한다.
>
> **기각된 대안(Rejected)**: 편의를 위해 프로필을 폭넓게 수집 — 민감정보 노출면 확대. 평문 저장 — 유출 시 피해 극대화. 상세는 [06-security-compliance.md](./06-security-compliance.md).

---

## 4. 이 문서 세트의 사용법

- 각 문서 상단에 **한 줄 요약**과 관련 문서 링크가 있다.
- 주요 의사결정마다 **결정 / 근거 / 기각된 대안** ADR 블록을 붙였다. 왜 이렇게 정했는지 되짚을 때 이 블록을 먼저 보라.
- DDL, JSON, mermaid 다이어그램은 실제 구현에 바로 옮길 수 있는 구체성을 목표로 한다.
- 이 문서는 **확정된 설계의 기록**이다. 재설계가 필요하면 별도 논의 후 문서를 개정한다.

---

## 부록. 프론트–백엔드 통합 잔여 과제 (2026-07-10 검토 기준)

현재 프론트 `shared.js`의 `DataService`는 **로컬(localStorage) 모드로만 동작**하며, REST 모드는
프로토타입 시절의 경로/페이로드를 유지하고 있다. 백엔드 MVP(`backend/`)와 다음 간극이 존재하므로,
`setBackend('rest', ...)`로 전환하기 전에 프론트 어댑터 작업이 선행되어야 한다.
(현 상태에서 REST 모드는 사용하지 않으므로 사용자에게 노출되는 결함은 없다.)

| # | 항목 | 프론트 현재 | 백엔드 실제 | 필요한 작업 |
|---|---|---|---|---|
| 1 | 경로 | `/api/profile`, `/api/sessions`, `/api/settings`, `/api/calibration` | `/api/v1/users/me/...` | 경로 매핑 |
| 2 | 인증 | 헤더 주입 지원만 있고 로그인 플로우 없음 | JWT Bearer + refresh 쿠키 | 로그인 화면·토큰 갱신 |
| 3 | 세션 페이로드 | `{gameId, sets:<정수>, durationSec, setDetails[]}` | `{clientSessionId, exerciseType, score, sets:[...]}` | 변환 어댑터(+멱등키 생성) |
| 4 | 세션 목록 응답 | 배열 기대 | `{data:[], meta:{nextCursor}}` | 언랩 + 커서 페이지네이션 |
| 5 | 캘리브레이션 | `PUT /api/calibration {baseline0,baseline100}` | `POST .../calibrations`, `GET .../latest` | 메서드·필드명 정렬 |
| 6 | 설정/프로필 필드 | `summaryEnabled`, `age` 등 | `sessionSummaryEnabled`, `birthDate` 등 | 필드명 정렬(+timezone 신규) |

> 게이미피케이션 계산 자체는 프론트 `GamificationEngine`과 백엔드 `services/gamification.py`가
> **동일 상수·동일 공식**으로 검증되어 있다(세션 XP 370 케이스 양쪽 일치). 전환 시 서버 값이 진실이다.
