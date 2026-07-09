# 05. 확장 로드맵

> **한 줄 요약**: Stage 0(지금)은 단일 컨테이너 모놀리식 + managed PostgreSQL + 오브젝트 스토리지, Redis 없음. 각 확장 요소는 명시적 트리거 지표에 도달했을 때만 도입한다(원칙 ③). 마지막에 "과설계 금지 목록"으로 무엇을 하지 않을지 못 박는다.

## 관련 문서
- 설계 원칙 ③(단계적 확장): [00-overview.md](./00-overview.md)
- 리더보드 인덱스 → Redis 이관: [01-erd.md](./01-erd.md) §7
- 업적 outbox 전환 스케치: [03-gamification-engine.md](./03-gamification-engine.md) §6.4
- 원시 시계열 Stage 3 경로: [04-sensor-data-policy.md](./04-sensor-data-policy.md)

---

## 원칙: 트리거 기반 확장

각 Stage는 **진입 트리거(지표)**가 있다. 트리거 전에는 그 Stage의 인프라를 도입하지 않는다. "미리 대비"라는 이름의 과설계를 배제한다([00](./00-overview.md) 원칙 ③).

---

## Stage 0 — 지금 (모놀리식)

**구성**
- **API**: 단일 모놀리식 서버 1개. 프레임워크는 팀 스택 기준으로 선정(아래 선정 기준 참조).
- **DB**: managed PostgreSQL 1 인스턴스(예: RDS/Cloud SQL). 자동 백업.
- **오브젝트 스토리지**: S3 호환(아바타 이미지). presigned URL로 서빙([06](./06-security-compliance.md)).
- **Redis 없음.**
- **배포**: 단일 컨테이너.

**프레임워크 선정 기준** (특정 프레임워크를 강제하지 않음)
- 팀이 이미 쓰는 언어/스택 우선(운영 숙련도가 성능 최적화보다 중요한 규모).
- 후보 예: **NestJS**(TypeScript, 프론트와 언어 통일 이점), **FastAPI**(Python, 빠른 개발), **Spring Boot**(JVM, 견고함). 셋 다 이 요구를 충분히 만족한다.
- 판단 축: ① 팀 숙련도, ② 트랜잭션/ORM 성숙도(세션 저장 트랜잭션이 핵심), ③ 채용 용이성.

> **결정(Decision)**: Stage 0는 단일 모놀리식 + managed PostgreSQL + S3 호환 스토리지, Redis 없음.
>
> **근거(Why)**: 유저 수십~수천 명, 세션 쓰기 초당 1건 미만([00](./00-overview.md))이면 단일 인스턴스가 여유롭게 감당한다. managed DB로 운영 부담을 낮추고, 애플리케이션 로직에 집중한다.
>
> **기각된 대안(Rejected)**: 처음부터 다중 서비스/캐시 계층 — 초기 규모에 운영 복잡도만 추가.

---

## Stage 1 — Redis 도입

**진입 트리거 (하나라도 충족)**
- DAU ≈ 1,000 도달, 또는
- 세션/조회 p95 지연 > 300ms, 또는
- **리더보드 기능 출시**([02](./02-api-spec.md) `/leaderboard`).

**추가하는 것**
- **Redis Sorted Set**: 리더보드(주간/전체 순위). `idx_user_stats_total_xp`([01](./01-erd.md))에서 ZSET으로 이관.
- **user_stats 캐시**: 홈/프로필의 total_xp·level·streak 조회를 Redis로 캐싱.
- **rate limit**: 세션 POST 등 남용 방지 카운터를 Redis로([03](./03-gamification-engine.md) §7).

**하지 않는 것**
- **세션 목록 캐시는 안 한다.** 개인화되어 있고(유저별 다름) 페이지네이션 특성상 히트율이 낮아 캐시 이득이 적다.

> **결정(Decision)**: Redis는 리더보드·핫 통계·rate limit에만. 세션 목록은 캐시하지 않는다.
>
> **근거(Why)**: 리더보드 정렬과 카운터는 Redis가 압도적으로 유리하다. 반면 세션 목록은 개인화·저히트율이라 캐시 복잡도만 늘고 정합성 리스크가 생긴다.
>
> **기각된 대안(Rejected)**: 모든 읽기를 캐시 — 무효화 복잡도·정합성 문제, 히트율 낮은 곳까지 캐시하는 낭비.

---

## Stage 2 — 읽기 복제본 + 집계 배치

**진입 트리거**
- B2B 대시보드 집계 쿼리가 세션 쓰기 경로와 **자원을 경합**하기 시작할 때(치료사 대시보드의 환자별 추이 집계가 무거워짐).

**추가하는 것**
- **읽기 복제본 1개**: 대시보드/리포트/집계 조회를 복제본으로 분리해 쓰기 경로 보호.
- **일별 집계 배치**: `daily_user_stats`(유저×일자 요약)를 야간에 생성. 대시보드는 raw 세션 대신 이 집계를 읽는다.
- **업적 outbox 워커 분리**: 알림/이메일 등 부작용이 세션 트랜잭션에 끼어들면 [03](./03-gamification-engine.md) §6.4의 `outbox_events`로 분리.

```sql
-- Stage 2 집계 테이블 스케치
CREATE TABLE daily_user_stats (
  user_id      uuid NOT NULL,
  stat_date    date NOT NULL,
  sessions     integer NOT NULL DEFAULT 0,
  avg_force    numeric(5,2),
  max_force    numeric(5,2),
  total_sets   integer NOT NULL DEFAULT 0,
  xp_earned    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, stat_date)
);
```

> **결정(Decision)**: 읽기 부하 분리는 복제본 + 일별 집계 배치로. 쓰기는 여전히 프라이머리 단일.
>
> **근거(Why)**: 이 규모의 병목은 쓰기가 아니라 대시보드 집계(읽기)다. 복제본과 사전 집계로 읽기를 흡수하면 프라이머리는 계속 여유롭다.
>
> **기각된 대안(Rejected)**: 쓰기 샤딩 — 쓰기가 병목이 아니므로 불필요. 실시간 집계 뷰 — 무거운 스캔을 매 조회마다 반복.

---

## Stage 3 — 임상 원시 시계열 계약

**진입 트리거**
- B2B 임상 요구가 계약으로 확정(치료사가 원시 파형 분석 요구, [04](./04-sensor-data-policy.md) ADR-04-3).

**추가하는 것**
- **TimescaleDB** 또는 **S3 Parquet 배치**: 원시 시계열 저장·질의 전용 경로.
- ingest 경로(`POST .../raw-samples`)만 분리. **이때도 MSA로 가지 않는다** — 원시 데이터 수집/저장 경로만 떼어낼 뿐 서비스 분해는 하지 않는다.

> **결정(Decision)**: 원시 시계열은 전용 스토리지(TimescaleDB/Parquet)로, ingest 경로만 분리. 코어는 여전히 모놀리식.
>
> **근거(Why)**: 원시 시계열은 관계형 코어와 접근 패턴이 완전히 다르다(대용량 append, 시간 구간 스캔). 전용 저장소가 맞다. 그러나 이는 저장 경로 분리이지 서비스 분해가 아니다.
>
> **기각된 대안(Rejected)**: 원시 시계열을 코어 PostgreSQL에 — 테이블 팽창·성능 저하. 이 요구를 위해 MSA 전환 — 과잉 분해.

---

## 과설계 금지 목록

아래는 **이 프로젝트의 규모·궤적에서 하지 않기로 확정**한 것들이다. 각 항목에 하지 않는 근거를 한 줄로 붙인다.

| 하지 않을 것 | 근거 |
|--------------|------|
| **마이크로서비스(MSA)** | 유저 수천 명·쓰기 초당 1건 미만 규모에서 서비스 분해는 운영 복잡도(분산 트랜잭션, 서비스 간 통신, 배포 조율)만 늘고 이득 없음. 모놀리식으로 충분. |
| **Kafka(이벤트 스트리밍)** | 이벤트량이 미미하고 부작용 분리는 DB `outbox_events`로 충분([03](./03-gamification-engine.md) §6.4). Kafka는 운영 오버헤드가 규모에 비해 과함. |
| **MongoDB(문서 DB)** | 데이터가 관계형(유저-세션-업적-원장)으로 명확하고 트랜잭션·정합성이 핵심. PostgreSQL의 `jsonb`로 반정형 요구(force_series)도 커버. |
| **GraphQL** | 클라이언트가 단일 웹앱이고 엔드포인트가 명확한 REST로 충분. GraphQL의 스키마/리졸버/N+1 관리 비용이 이득을 초과. |
| **Kubernetes** | 단일~소수 컨테이너 규모에 K8s는 과함. managed 컨테이너 서비스(ECS/Cloud Run 류)로 충분. |
| **파티셔닝/샤딩** | 10만 유저 3년치도 수억 행 미만([01](./01-erd.md) §8). `sessions`가 수천만 행을 넘을 때만 월별 파티셔닝 재검토. 샤딩은 논외. |

> 이 목록은 "지금은 안 한다"이지 "영원히 안 한다"가 아니다. 각 항목은 명시적 트리거(규모 지표)가 실제로 관측될 때 재검토한다. 다만 그 전까지 도입하지 않는 것이 원칙 ③이다.
