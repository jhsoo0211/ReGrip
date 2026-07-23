# 09 · ML 학습 — NinaPro DB2 40명 인제스트 + EMG 제스처 분류

> 08(신호 카탈로그)에서 만든 sig_* 카탈로그에 **실제 NinaPro DB2 40명**을 인제스트하고,
> 그 위에서 **EMG 기반 손동작 분류 모델**을 학습·평가한 기록. 데이터 구조·**원본 변수별 처리**·
> 인제스트 절차·학습 방법·결과·재현 방법을 담는다. 2026-07-23 수행.

---

## 0. 요약

- **데이터**: NinaPro DB2 subject 1~40 (각 3파일 E1/E2/E3), 총 **120개 기록**을 카탈로그에 인제스트.
- **모델**: 12채널 EMG 시간영역 특징 → RandomForest로 **49개 손동작 분류**(피험자별).
- **결과**: 테스트 정확도 **평균 73.5% ± 7.0%** (피험자 범위 54.9~87.3%). NinaPro DB2 문헌 수준과 일치.
- **ReGrip 관점**: 지금 모델의 입력은 **12채널 EMG**다. 현재 ReGrip은 FSR 악력 1채널이라 그대로는 못 올리지만,
  **EMG 하드웨어 확장을 고려 중이라면 이 학습이 곧 기기 제스처 인식의 기반이 된다**(§5).

---

## 1. 데이터 구조

### 1.1 원본 (NinaPro DB2)
피험자 1명당 `.mat` 3개 = 운동 프로토콜 3블록:

| 파일 | exercise | 블록 | 동작 | `.mat` 변수 |
|---|---|---|---|---|
| `S{n}_E1_A1.mat` | 1 | **B** | 기본 손가락/손목 17종 | emg·acc·glove·inclin + 라벨 |
| `S{n}_E2_A1.mat` | 2 | **C** | 기능적 파지 23종 | emg·acc·glove·inclin + 라벨 |
| `S{n}_E3_A1.mat` | 3 | **D** | 힘 패턴 9종 | emg·acc·**force·forcecal**·activation + 라벨 |

(라벨 변수 = stimulus·restimulus·repetition·rerepetition, 스칼라 = subject·exercise. §1.2에서 변수별 처리를 명시한다.)

### 1.2 원본 변수는 어떻게 반영됐나 (변수별 처리) ★

`.mat` 변수 13종 각각을 인제스트가 어떻게 다루는지. **로더(`scripts/sig/mat_loader.py`)의 허용 목록
(`DB2_KNOWN_KEYS`)에 13종 전부가 있어 로드가 통과**된다(목록에 없는 키가 하나라도 있으면 `ValueError`로
로드 중단). "허용"과 "실제 사용"은 별개다 — 아래 표가 그 구분이다.

| 변수 | 처리 | 상세 |
|---|---|---|
| **emg** | blob `emg` (항상) | 12ch, **2000Hz 그대로**(리샘플 안 함), unit `mV`, 채널명 `EMG_1..12`. **이 학습의 입력.** |
| **acc** | blob `acc` (항상) | 36ch(12센서×3축), 2000→**148Hz** 다운샘플, unit `g`, 채널명 `ACC_s{n}_{x/y/z}` |
| **glove** | blob `joint_angle` (E1/E2) | 22ch, 2000→**25Hz**, unit `n/a`(무보정 CyberGlove ADC), 채널명 `CG_01..22`. E3엔 없음 |
| **force** | blob `force` (E3) | 6ch, 2000→**100Hz**, unit `mvc_frac`, 채널명 `FORCE_1..6`. **blob엔 raw 값 저장**·gain/offset은 채널 메타 |
| **forcecal** | **force 정규화 계수 산출**(blob 아님) | 2×6 행렬. row0=min·row1=max → `gain=1/(max-min)`, `offset=-min/(max-min)`. 적용식 `(raw-min)/(max-min)`. 방향(max>min) 검증, 없으면 force 인제스트 실패 |
| **restimulus** | **라벨** → `sig_segment` | per-sample 동작코드 → run-length로 구간 압축. **전역 코드 0=rest·1~17 B·18~40 C·41~49 D** (오프셋 가산 없음, 블록 허용범위 검증) |
| **rerepetition** | `sig_segment.repetition` | 구간 내 max(반복 회차 1~6). rep 기반 train/test 분할에 사용 |
| **subject** | `sig_subject.source_subject_id` | 스칼라 1~40 |
| **exercise** | 블록 매핑 | 스칼라 1/2/3 → file_token E1/E2/E3, `protocol_block` **B/C/D**. 블록이 라벨 허용범위·존재 모달리티를 결정 |
| **stimulus** | **허용하지만 미사용** | restimulus(정제된 라벨)를 대신 씀 |
| **repetition** | **허용하지만 미사용** | rerepetition(정제된 반복)을 대신 씀 |
| **inclin** | **허용하지만 미사용** | E1/E2의 경사계 2ch. blob·메타·라벨 어디에도 안 씀(로드 중단 방지용으로 허용 목록에만 있음) |
| **activation** | **허용하지만 미사용** | E3의 근활성 추정. 마찬가지로 허용만 하고 미사용 |

핵심: **`stimulus`/`repetition`/`inclin`/`activation` 4종은 "받아들이되 쓰지 않는다".** 라벨은 `restimulus`,
반복은 `rerepetition`만 쓰고, inclin/activation은 이번 제스처·힘 과제에 불필요해 blob으로 만들지 않는다.
(그래도 로더가 이 키들을 목록에 둔 이유는, 실파일에 존재하는 키인데 목록에 없으면 로드 자체가 중단되기 때문이다.)

### 1.3 카탈로그 (sig_* 7테이블) — 이번 40명 인제스트 결과

```
sig_dataset(1)         ninapro_db2, license=citation-only, redistributable=false
└ sig_subject(40)      s1~s40
  └ sig_recording(120) 피험자×블록 (B:40 C:40 D:40)
    ├ sig_signal_blob(360)  기록×모달리티 (emg:120 acc:120 glove:80 force:40)
    │ └ sig_channel(7760)   채널 메타(이름·단위·gain/offset)
    └ sig_segment(23640)    구간 라벨 (움직임 11760 = 40×49×6, rest 11880)
```

- **원시 신호는 DB에 없다.** 각 blob은 content-addressed `.npy` 파일(`rel_path`=`blobs/sha256/xx/yy/<64hex>.npy`,
  `sha256`로 무결성)로 저장되고 DB엔 메타(샘플수·채널수·레이트·경로·해시)만. 총 **blob 360개, 11.56GB**
  (gitignore된 `backend/storage/sig-blobs/`, 커밋 안 됨).
- **레이트 이원화**: `native_rate_hz`(실제 정보 레이트, 예 acc 148)와 `stored_rate_hz`(원본 .mat 저장 레이트 2000).
  원본 .mat은 모든 모달리티를 2000Hz로 맞춰 저장하지만(전부 같은 행수), 카탈로그는 각자 native로 다운샘플한다.
  **EMG만 native=stored=2000이라 segment 샘플 인덱스가 EMG blob과 1:1 정렬**된다(학습이 이 성질을 씀).
- **움직임 세그먼트 11,760 = 40명 × 49동작 × 6반복** 정확히 일치 → 라벨 정합성 확인됨.

---

## 2. 인제스트 절차

### 2.1 파이프라인
`.mat` → **mat_loader**(키 검증·probe) → **preproc**(`resample_poly`로 native 레이트로 다운샘플, EMG는 그대로)
→ **blobstore**(float32 `.npy` 직렬화 → sha256 → content-addressed 저장) → **segments**(restimulus run-length →
`[start,end)` 구간, 전역 코드로 라벨). 오케스트레이터 `scripts/sig/ingest_db2.py`, 배치 CLI `scripts/sig/ingest_batch.py`.

### 2.2 실데이터에서 드러나 바로잡은 것 (합성 데이터로는 못 잡던 것)
20명 시점에 s1로 probe해 파이프라인 가정 오류 5건을 수정했고(상세 08 §3), 40명 인제스트에서 임계값 1건을 추가로 조정:
- **미지 키**: 실파일의 `inclin`(E1/E2)·`activation`(E3)을 허용 목록에 추가(§1.2). 없으면 3파일 다 로드 거부됐다.
- **라벨 오프셋 제거**: restimulus가 **이미 전역 코드**(E2=18~40, E3=41~49, 어휘와 일치)라 오프셋을 더하면
  오라벨. 값을 그대로 쓰되 블록별 허용범위를 검증한다(C 18→18, D 41→41).
- **glove 옵션화**: E3엔 glove 없이 force → 존재하는 모달리티로만 blob 구성.
- **force 정규화**: forcecal에서 gain/offset 산출(§1.2 forcecal 참조), 방향(max>min) 검증.
- **길이 정렬**: 신호와 라벨 길이가 경계 트림으로 조금 어긋남(실측 s1_E3=1, s12_E3=272 샘플) → 공통 최소 길이로
  정렬. 허용치는 고정 256이 s12(272)를 잘못 막아 **신호 길이의 1%+절대 바닥**으로 바꿨다(그래서 40명 120/120 성공).

### 2.3 결과·재현
- 120개 기록 **전부 성공**(실패 0). 40명 배치 인제스트 약 6분.
- 재현(반드시 `backend/`에서 실행):
  ```powershell
  cd backend
  python scripts/sig/ingest_batch.py --subjects 1-40 --fresh
  ```
  blob·DB는 `backend/storage/`(gitignore)에 생성. 원본 `.mat`은 저작권상 저장소에 안 넣는다
  (ninapro.hevs.ch 등록 후 각자 내려받아 `~/Downloads/DB2_s{n}/` 에 압축 해제).

---

## 3. 학습 방법

**과제**: EMG 12채널으로 **어떤 손동작인지** 분류(49동작, rest 제외). NinaPro의 표준 벤치마크.

**방식** (`scripts/ml/train_gesture.py`):
1. **윈도잉**: 각 라벨 구간(동작 1회 반복) 안에서 EMG를 **200ms 창(400샘플)·100ms 보폭(200샘플)**으로 슬라이딩.
   창 하나 = 표본 1개, 라벨 = 그 구간의 동작 코드. EMG는 2000Hz 1:1 정렬이라 segment 인덱스를 그대로 슬라이스.
2. **특징**(채널당 5종, 표준 sEMG 시간영역 = 5×12ch = **60차원**):
   MAV(평균절대값)·RMS·WL(파형길이)·ZC(영교차)·SSC(기울기부호변화).
3. **분할**(Atzori DB2 공식 프로토콜): 6반복 중 **train {1,3,4,6} / test {2,5}**. 같은 동작의 다른 반복으로
   나눠 "본 적 없는 반복"에서 평가 → 낙관 편향 없음.
4. **모델**: RandomForest(150 trees). 스케일링 불필요, sEMG 분류의 표준 기준선.
5. **피험자별(intra-subject)**: EMG는 개인차가 커 피험자 간 일반화가 어렵다. 40명 각각 학습·평가 후 평균 —
   NinaPro의 표준 보고 방식.

의존성: `requirements-ml.txt`(scikit-learn, matplotlib). numpy/scipy/sklearn은 `scripts/`·학습에만 쓰고
운영 API(`src/`)는 여전히 stdlib-only(08의 격리 규칙 유지).

---

## 4. 결과

**피험자 40명 평균 테스트 정확도 73.5% ± 7.0%** (균형정확도 74.2% ± 6.5%),
피험자 범위 **54.9% ~ 87.3%**. 전체 테스트 창 통합(micro) 73.1%. 학습·평가 총 약 110초.

![피험자별 정확도](assets/ml_accuracy.png)

**블록별 정확도**: B(기본 손가락, 17종) **76.5%** · C(기능적 파지, 23종) **65.9%** · D(힘, 9종) **87.2%**.
C가 가장 어렵다 — 파지 동작이 많고(23종) 서로 유사(주먹·구형·원통형 등)해 혼동이 크다.
D가 가장 쉽다 — 동작이 9종으로 적고 힘 패턴이 뚜렷하다.

![혼동행렬](assets/ml_confusion.png)

혼동행렬(행 정규화)에서 오분류가 **블록 대각 블록 내부**에 몰려 있다(같은 블록의 유사 동작끼리 헷갈림).
블록 간(B↔C↔D) 혼동은 적다 — 손가락/파지/힘은 EMG 패턴이 충분히 구분된다.

이 수치는 문헌(Atzori et al. 2014, DB2에서 고전 특징+분류기 ~75%)과 일치한다 —
파이프라인이 올바르게 동작함을 뒷받침한다. (20명 기준 75.9%였고, 40명으로 늘리며 어려운 피험자가 포함돼
평균이 소폭 내려갔다 — 정상적인 경향이다.)

---

## 5. ReGrip 적용 관점 — 현재 한계와 **EMG 확장 시 직접 활용**

**지금 이 모델의 입력은 12채널 EMG다.** 현재 양산 ReGrip은 FSR 악력 1채널뿐이라 이 모델을 기기에
그대로 올릴 수는 없다. 하지만 **EMG 하드웨어 확장을 고려 중이라면 상황이 달라진다** — 이 작업은
"파이프라인 실증"을 넘어 **EMG 기반 제스처 인식의 실질적 기반**이 된다.

이 단계에서 확보한 것:
1. **실데이터 end-to-end 검증** — 인제스트→blob→segment→특징→학습→평가가 실 NinaPro로 성립.
2. **재현 가능한 기준선** — 윈도잉·특징·반복분할·평가 방법론이 확립됐고, 40명 기준선(73.5%)이 있다.
3. **EMG 확장 시 즉시 재사용할 자산** — 아래 로드맵의 출발점.

### EMG 확장 로드맵 (기기에 EMG를 달 경우)
- **채널 수 정합**: NinaPro DB2는 12ch(Delsys Trigno)다. 웨어러블 ReGrip은 더 적은 채널(예: 손목 밴드 4~8ch)이
  현실적이다. → **NinaPro 12ch 중 부분집합으로 재학습**해 목표 채널 수의 상한 성능을 미리 가늠할 수 있다
  (이 카탈로그의 EMG blob은 채널을 슬라이스만 하면 되므로 재인제스트 없이 실험 가능).
- **전극 배치·샘플레이트**: DB2는 전완 근육 주변 배치·2kHz. 기기 배치/레이트가 다르면 도메인 격차가 생기므로,
  ReGrip 하드웨어 사양이 정해지면 그 조건으로 다시 수집·미세조정한다.
- **FSR+EMG 융합**: 기기가 FSR(악력)와 EMG(제스처)를 함께 가지면, 이 카탈로그 구조 그대로
  두 모달리티를 한 recording에 담아(각각 `modality='fsr'`/`'emg'`) 융합 모델을 학습할 수 있다.
- **전이학습**: NinaPro로 사전학습한 표현을 소량의 기기 데이터로 미세조정 — 기기 데이터 수집 비용을 줄인다.

### FSR 전용으로 남는 경우
EMG 확장을 안 한다면, ReGrip에 직접 유용한 건 **E3의 force 채널**(악력에 가장 가까움)과
"악력 세기 추정·목표 유지 판정" 같은 **회귀 과제**다. 이번 분류는 파이프라인 실증용이며, 그 경우엔
force 회귀(§7)로 방향을 튼다.

---

## 6. 재현 방법

```powershell
cd backend
.\venv\Scripts\python.exe -m pip install -r requirements-ingest.txt -r requirements-ml.txt

# 1) 40명 인제스트 (원본 .mat 은 ~/Downloads/DB2_s{1..40}/ 에 압축 해제돼 있어야 함)
.\venv\Scripts\python.exe scripts/sig/ingest_batch.py --subjects 1-40 --fresh

# 2) 제스처 분류 학습·평가
.\venv\Scripts\python.exe scripts/ml/train_gesture.py --win 400 --step 200
#    → backend/storage/train_results.json (피험자별 + 요약), train_preds.npz (예측)
```

- 두 CLI의 기본 경로는 `backend/` 기준으로 고정돼 있어(`_BACKEND` 앵커) 어느 CWD에서 실행해도
  `backend/storage/`에 쓴다.
- blob·DB·결과 JSON·예측은 전부 `backend/storage/`(gitignore) → 저장소에 안 들어간다.
- 원본 데이터셋은 라이선스상 재배포하지 않는다(citation-only). 각자 ninapro.hevs.ch에서 내려받는다.
- 그림(`assets/ml_accuracy.png`, `ml_confusion.png`)은 학습 산출물로 문서와 함께 커밋한다.

## 7. 다음 단계
- **EMG 확장 로드맵**(§5) — 하드웨어 사양 확정 시 채널 부분집합 재학습 → 기기 수집 → 미세조정.
- **force 회귀** — E3 force로 악력 추정 모델(FSR 전용 ReGrip에 더 직접적).
- **ReGrip FSR 데이터 파이프라인** — 기기→WebSocket→카탈로그(`modality='fsr'`) 수집 경로.
- **DB9(관절각)** — `s_1_angles.zip` 보유. 손가락 각도까지 추정할 경우에만 필요(선택).
