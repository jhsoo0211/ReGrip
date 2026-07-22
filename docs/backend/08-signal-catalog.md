# 08 · 신호 카탈로그 (NinaPro / sig_*) — 역할·현재 상태·검토·후속

> 이 문서는 `backend/src/models/signal.py`, `backend/src/services/signal_*.py`,
> `backend/scripts/sig/`, `backend/migrations/003_signal_catalog.sql` 로 구성된
> **신호 카탈로그(sig_\*)** 서브시스템을 설명한다. 이 코드 전체는 아직 커밋되지 않았고(untracked),
> 실데이터도 들어오지 않은 **골격(scaffold) 단계**다. 배경 결정은 04(센서 데이터 정책)와 이어진다.

---

## 0. 한 줄 요약 — "지금 이건 뭐냐"

공개 재활/근전도 데이터셋(**NinaPro**)을 ReGrip DB 스키마에 정렬해 **제스처·힘 추정 ML 학습**에 쓰기
위한 **데이터 수신 골격**이다. **아직 실데이터는 없다.** 스키마·인제스트 파이프라인·합성 데이터
테스트만 완성돼 있고, 실제 NinaPro 신호는 등록 게이트 뒤에 있어 **직접 내려받아야** 채워진다.

- **왜 필요한가**: ReGrip 기기는 FSR 악력 센서(0~100% force) 하나를 쓴다. 이 한 채널만으로
  "지금 어떤 동작을 하는지(제스처)"·"얼마나 힘을 주는지(force)"를 추정하려면 학습 데이터가 필요한데,
  기기에서 환자 데이터를 대량 모으기 전에 **공개 데이터로 모델을 선학습**해 두려는 것이다.
- **무엇을 담나**: DB엔 **메타데이터+요약만** 넣고, 원시 신호(초당 수천 샘플)는 **파일**로 따로 둔다
  (content-addressed `.npy`, `rel_path`/`sha256` 로 참조). DB가 신호 벌크로 비대해지지 않게 하는 결정.

---

## 1. 지금 들어온 것 / 안 들어온 것 (사실 확인)

| 항목 | 상태 |
|---|---|
| 7개 테이블 스키마 (ORM + PG DDL) | ✅ 완성 |
| 인제스트 파이프라인 (.mat 로드 → 리샘플 → blob 저장 → 구간 라벨) | ✅ 코드 완성 |
| 라벨 어휘 (`data/labels_ninapro_hand_v1.json`, 50개 동작 코드) | ✅ 있음 — **단, 이건 "동작 이름 사전"이지 신호가 아니다** |
| 합성 데이터 테스트 (`make_synthetic_db2.py` + pytest) | ✅ 통과 |
| **실제 NinaPro 신호 데이터 (.mat)** | ❌ **없음** — 등록 게이트 뒤, 사용자가 받아야 함 |
| 인제스트된 blob(`.npy`) / blob 저장소 | ❌ 없음 |
| DB9(관절각) 정상범위 `norms_db9_v1.json` | ❌ 없음 |
| HTTP API / 스키마 (`src/api/signals.py` 등) | ❌ 없음 — 카탈로그가 아직 외부로 노출 안 됨 |
| 인제스트 CLI(`__main__`) / `blob_root` 설정 키 | ❌ 없음 — 배치 실행 진입점 미비 |

**결론**: "전에 준 방향(NinaPro로 학습)"에 맞춰 **받을 그릇**을 만든 상태다.
실데이터로 세팅하는 단계는 **아직 시작 전**이며, 아래 §4 순서를 따른다.

---

## 2. 구조 — 파일별 역할

### 2.1 데이터 모델 (`src/models/signal.py`, `migrations/003_signal_catalog.sql`)

7개 테이블. 상위→하위:

```
sig_dataset      데이터셋 출처·라이선스·인용 (예: NinaPro DB2)
└ sig_subject    피험자 (익명 id, 인구통계)
  └ sig_recording  한 번의 기록 세션 (피험자×운동블록)
    ├ sig_signal_blob  모달리티별 원시신호 파일 참조 (rel_path/sha256/샘플수/채널수/레이트)
    │ └ sig_channel    채널 메타 (이름·단위·gain/offset)
    └ sig_segment     구간 라벨 (start~end 샘플, 어떤 동작인지)
        └ sig_label   동작 어휘 (code→name, data/labels_*.json 에서 seed)
```

**핵심 설계**: 1채널 FSR 스트림과 70채널 NinaPro 기록이 **채널 행 수만 다른 동일 구조**가 된다.
지금은 NinaPro 인제스트만 구현돼 있고, 기기 측 FSR 경로(`modality='fsr'`)는 **스키마만 있고 아무도 안 씀**.

`src/models/base.py`의 `CreatedAtMixin`은 sig_* 전용(append-only라 `updated_at` 없음).

### 2.2 신호처리 상수·산술 (`src/services/signal_offsets.py`)

DB2의 레이트·라벨 오프셋을 **stdlib(`Fraction`)만으로** 계산. `src/`에 있지만 API는 안 쓰고
`scripts/`·`tests/`만 소비한다. (원래 `scripts/sig/`에 있었어야 할 모듈 — §3 caveat 참조.)

- 네이티브 레이트: EMG 2000Hz / ACC 148Hz / glove 25Hz / force 100Hz (DB2는 전부 2kHz로 저장됨)
- 라벨 오프셋: 블록 B=0, C=17, D=40 (파일별 restimulus 재시작을 전역 0~49 코드로 승격)

### 2.3 어휘 seed (`src/services/signal_vocab.py` + `data/labels_ninapro_hand_v1.json`)

`seed_sig_labels()`가 50개 동작 코드(0=rest, 1~17=B, 18~40=C, 41~49=D)를 멱등 upsert.
**라벨명은 플레이스홀더**(`B_01`…)이고 실제 동작명(예: "엄지 굽힘")은 아직 안 붙었다.

### 2.4 인제스트 파이프라인 (`scripts/sig/`, numpy/scipy 사용)

| 파일 | 역할 |
|---|---|
| `mat_loader.py` | `.mat` 로드, 알 수 없는 키는 중단, `probe()`로 ground-truth 기록 |
| `preproc.py` | `scipy.signal.resample_poly`로 네이티브 레이트로 리샘플 |
| `blobstore.py` | `.npy` 직렬화 바이트의 sha256 → content-addressed 원자적 저장 |
| `segments.py` | restimulus run-length → `[start,end)` 구간 |
| `ingest_db2.py` | 오케스트레이터 (dataset→subject→recording→blob→channel→segment) |
| `make_synthetic_db2.py` | 실데이터 없이 테스트하는 **결정적 가짜 `.mat` 생성기** |
| `scrape_db2_subjects.py` | 피험자 인구통계 표 파서 (stdlib) — **산출물이 아직 인제스트에 연결 안 됨** |

### 2.5 의존성 경계 (잘 지켜지는 부분)

numpy/scipy는 `scripts/sig/`·`tests/`에만. `src/`는 stdlib only.
`tests/test_dependency_isolation.py`가 **subprocess로** `src.main` 임포트 후 numpy/scipy 부재를 강제.
운영 API 컨테이너가 무거워지는 것을 막는, 이 저장소에서 가장 잘 지켜지는 아키텍처 경계다.

### 2.6 앱과의 결합 (2026-07-23 디커플 완료)

sig는 **선택적 서브시스템**이다. `models/__init__.py`·`main.py`·`conftest.py`가 sig 모듈을
`try/except ImportError`로 감싸므로, **sig 파일이 없어도 백엔드는 sig_* 없이 정상 기동·테스트**된다
(검증: sig 파일 부재 시 `from src.main import app` 성공, 비-sig 테스트 62개 통과).
덕분에 sig 코드는 앱 본체와 **독립적으로 커밋**할 수 있다.

---

## 3. 검토가 필요한 것 (사용자 판단 · 실데이터 전에 닫아야 할 함정)

### 3.1 결정이 필요한 사안

- **라이선스**: NinaPro 본사이트는 라이선스 명시가 없다. DB9=CC BY(Zenodo), DB2=Dryad CC0(추정·미확인),
  같은 그룹 DB4/5=CC BY-ND(**파생 재배포 금지**). 현재 결정은 "원본 재배포 안 함, 학습 가중치만,
  `license_code='citation-only'`". **실제 내려받는 DB의 라이선스를 확인**하고 이 결정을 유지할지 판단 필요.
- **리샘플 방식**: A안(네이티브 레이트 저장, 총 약 11.3GB) 확정됨. 저장 용량 감당 가능한지 확인.
- **라벨명**: `B_01…` 플레이스홀더를 실제 동작명으로 채울지, 코드로 둘지.
- **DB9 포함 여부**: 지금은 DB2(EMG)만. 관절각(DB9)까지 정렬할지.

### 3.2 실데이터 인제스트 **전에** 반드시 고쳐야 할 결함 (코드 리뷰 산출 · 상세는 계획 파일 참조)

지금은 합성 데이터라 안 터지지만, 실 NinaPro를 넣는 순간 터지거나 **조용히 오염**시키는 지뢰들:

| # | 위치 | 문제 | 심각도 |
|---|---|---|---|
| S1 | `003.sql` + `main.py` | 운영 PG에서 `sig_label`이 영구 0행(seed가 SQLite에만 연결, 003엔 INSERT 없음) → 인제스트 전량 실패 | 치명 |
| S2 | `segments.py`+`mat_loader.py` | restimulus 블록 재시작 가정이 **검증 안 됨** → 조용한 오라벨(부분 오염) | 치명 |
| S3 | `signal_offsets.py` | segment(2kHz)↔blob(native) **샘플 인덱스 변환기 없음** → 정렬 어긋남 | 높음 |
| S4 | `signal.py`/`003.sql` | `UNIQUE(rel_path)`가 content-addressed dedup과 **정면 모순**(동일 내용 두 레코딩 공존 불가) | 높음 |
| S5 | `ingest_db2.py` | forcecal 방향 가정의 **자기충족 검증** + forcecal 부재 시 TypeError | 중간 |
| S6 | `ingest_db2.py`/`003.sql` | `unit`이 "저장값 단위"와 "보정 후 단위"로 **혼용** | 중간 |
| S7 | `preproc.py` | 제로패딩 엣지 트랜지언트 + spec 불완전(window/padtype 누락) + 비정수 레이트(148.148Hz) 절단 | 중간 |
| S8 | 여러 곳 | 도달불가 복구분기·모달리티 길이검증 부재·blob 무결성 미검증·읽기 함수 부재 등 | 낮음~중간 |

> 전체 근거·수정 방향은 검토 계획 파일 `C:\Users\jhsoo\.claude\plans\regrip-snappy-rivest.md`
> 의 "신호 카탈로그" 절(S1~S8) 참조.

---

## 4. 추후 할 일 (권장 순서)

1. **NinaPro DB2 내려받기** (ninapro.hevs.ch 등록 게이트). 관절각도 쓸 거면 DB9(Zenodo)도.
   → 라이선스 확인(§3.1).
2. **S1~S5 지뢰 닫기** (실데이터가 이 경로들을 처음 밟는다). 최소 S1(어휘 seed)·S2(라벨 검증)는 필수.
3. **인제스트 진입점 마련**: `ingest_db2.py`에 `__main__`/argparse, `blob_root` 설정 키(`.env`),
   배치 실행 스크립트.
4. **실데이터 인제스트 + 검증**: 파일별 `unique(restimulus)` probe로 블록 재시작 가정 실증,
   blob 왕복(`np.load`) 정합성 확인.
5. **DB9 정상범위** `norms_db9_v1.json` (관절각 쓸 경우).
6. **ML 학습 파이프라인 연결**: 카탈로그 → 학습셋 추출 → 모델 → ReGrip 기기(FSR 1채널)에 적용.
   이 단계에서 기기 측 `modality='fsr'` 경로도 실제로 쓰이기 시작한다.
7. **API 노출**(필요 시): 지금은 카탈로그가 HTTP로 안 나온다. 학습 파이프라인이 파일 직접 접근으로
   충분하면 API는 후순위.

---

## 5. 커밋 전략 메모

sig 코드 전체가 untracked이고 앱 본체와 디커플됐으므로(§2.6):

- **커밋 A(앱)**: 프론트 + 백엔드 안전망 + 가드된 sig 배선. sig 파일 없이 자기완결(테스트 62개).
- **커밋 B(sig)**: 이 서브시스템 전체(`models/signal.py`, `services/signal_*.py`, `data/`,
  `scripts/sig/`, `migrations/003`, sig 테스트 6개, `requirements-ingest.txt`).
  실데이터·검증 준비될 때 넣는 것을 권장.

두 커밋은 디커플 덕에 **순서 무관**하게 각자 완결된다.
