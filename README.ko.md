# ReGrip

[English](README.md) | [한국어](README.ko.md)

손 압력 입력을 게임·훈련 기록·피드백으로 연결하는 가정용 손 재활 웹 프로토타입입니다.

ESP32 압력 센서로 게임 4종을 조작하거나 키보드와 화면 버튼으로 체험할 수 있습니다. 훈련 결과는 브라우저에 저장하며, FastAPI 백엔드를 함께 실행하면 계정과 서버 동기화 기능을 사용할 수 있습니다. 현재 앱 화면은 한국어로 제공합니다.

## 주요 기능

- **게임형 훈련 4종:** 풍선·크레인·리듬·잠수함 게임, 난이도 조절, 짧은 연습 모드
- **센서 연결·보정:** 브라우저 BLE를 통한 ESP32 FSR 입력, 개인별 압력 보정, 진단 그래프 및 기존 WebSocket 입력 지원
- **일시정지·재개:** 센서 수신 중단이나 탭 숨김 시 게임을 멈추고 사용자 조작으로 재개
- **기록·보상:** 점수, 훈련 이력, 통계, XP·레벨·업적과 센서·시뮬레이션 기록 구분
- **로컬 저장·동기화:** 훈련 결과 보존, 실패한 전송 재시도, 기록·보상 중복 방지 및 계정·API별 데이터 분리

## 빠른 시작

### 센서 없이 체험하기

Git과 Python이 필요합니다. 아래 명령은 Windows PowerShell과 Python 3.11 기준입니다.

```powershell
git clone https://github.com/jhsoo0211/ReGrip.git
cd ReGrip
py -3.11 -m http.server 3000 --bind 127.0.0.1
```

[localhost:3000](http://localhost:3000)을 열고 게임을 선택한 뒤 **시뮬레이션 사용**을 누릅니다. **Space** 또는 화면의 누르기 버튼으로 조작합니다. 연습은 최대 20초이며 훈련 기록과 XP를 저장하지 않습니다.

시뮬레이션과 로컬 기록에는 프런트엔드 빌드나 백엔드가 필요하지 않습니다. Tailwind와 일부 폰트를 CDN에서 불러오므로 최초 화면 로드에는 인터넷 연결이 필요합니다.

### ESP32 센서 연결하기

Windows Chrome 또는 Edge에서 HTTPS나 localhost로 접속합니다. [센서 가이드](docs/SENSOR_GUIDE.md)에 따라 BLE 펌웨어 빌드·업로드, 기기 연결, 이완 상태와 편안하게 쥔 상태의 압력 보정을 진행합니다.

게임은 **FSR 압력 채널**로 조작합니다. 두 번째 채널은 가변저항으로 flex 입력을 모사하는 진단용입니다. 센서 입력은 브라우저에서 처리하므로 이 경로에도 백엔드는 필수가 아닙니다.

### 계정·서버 동기화 사용하기

저장소 루트에서 백엔드 의존성을 설치합니다.

```powershell
py -3.11 -m venv backend/venv
.\backend\venv\Scripts\python.exe -m pip install -r backend/requirements.txt
```

기존 SQLite DB가 있다면 API를 중지하고 먼저 [DB 업그레이드 안내](backend/README.md)를 따릅니다. 기존 DB는 유지하며, 업그레이드 도구가 백업을 만들고 기록을 보존합니다.

앞서 실행한 단독 프런트엔드 서버를 종료한 뒤 아래 명령을 실행합니다.

```powershell
.\scripts\dev-start.ps1
# 두 서버 종료:
.\scripts\dev-stop.ps1
```

- 앱: [localhost:3000](http://localhost:3000)
- API 문서: [localhost:8000/docs](http://localhost:8000/docs)

환경 설정과 데이터베이스 구성은 [백엔드 README](backend/README.md)를 참고합니다.

## 연구 데이터와 머신러닝

저장소에는 [NinaPro DB2](https://ninapro.hevs.ch/instructions/DB2.html)를 활용한 오프라인 손동작 분류 연구도 포함되어 있습니다. 데이터셋의 원 논문은 [Atzori et al. (2014)](https://www.nature.com/articles/sdata201453)입니다.

| 항목 | ReGrip에서 활용한 내용 |
| --- | --- |
| 데이터 | 실험 기록 기준 40명·120개 기록을 내려받아 신호 카탈로그에 적재 |
| 처리 | 신호 배열과 메타데이터를 분리 저장하고, 정제된 동작·반복 라벨로 학습 표본 구성 |
| 모델 | 12채널 EMG에서 시간영역 특징 60개를 추출해 RandomForest로 49개 손동작 분류. 피험자별로 서로 다른 반복을 학습·평가에 사용 |
| 기록된 결과 | [실험 보고서](docs/backend/09-ml-training.md)의 피험자별 평균 테스트 정확도 **73.5% ± 7.0%**(표준편차) |

데이터 적재·학습·시각화 코드는 향후 EMG 확장을 검토할 수 있는 연구 기반입니다. **학습한 EMG 모델은 현재 FSR로 조작하는 게임에 연결되어 있지 않으며**, 위 수치는 새로운 사용자에 대한 성능이나 임상 효과를 의미하지 않습니다.

저장소에는 코드와 요약 그림이 포함되어 있습니다. 원본 다운로드, 처리한 신호 파일, 로컬 학습 결과 파일은 커밋하지 않았습니다. 원본은 NinaPro에서 직접 받아 해당 출처의 접근·인용 조건에 따라 사용합니다.

변수별 처리·평가 방법·그림·재현 절차는 [실험 보고서](docs/backend/09-ml-training.md), 저장 구조·적재 과정은 [신호 카탈로그](docs/backend/08-signal-catalog.md)를 참고합니다. 상세 문서에는 과거 결정도 포함되어 있으며, 현재 제품 연결 범위는 [아키텍처](ARCHITECTURE.md)를 기준으로 합니다.

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| 웹 앱 | HTML, CSS, Vanilla JavaScript, Tailwind CSS |
| 게임·진단 | DOM/SVG, requestAnimationFrame, Canvas 진단 그래프 |
| 백엔드 | Python 3.11, FastAPI, SQLAlchemy, Pydantic |
| 저장소 | localStorage, SQLite; PostgreSQL 마이그레이션 제공 |
| 기기 | ESP32, Arduino, PlatformIO, BLE; 기존 Wi-Fi WebSocket |

## 검증 현황

2026년 9월 5일 [검증 기록](docs/VERIFICATION.md)에는 **프런트엔드 71개·백엔드 145개 테스트 통과**, BLE 펌웨어 빌드 성공, 로컬 서버 실행 및 SQLite 업그레이드 확인 결과가 정리되어 있습니다.

실제 ESP32 업로드·무선통신, 브라우저 조작·화면 검수, PostgreSQL 실행은 후속 검증이 필요합니다. 현재는 개발용 프로토타입이며 임상적 효과는 확인되지 않았습니다. 별도 EMG 연구 코드는 게임에 연결되어 있지 않습니다.

백엔드 설치 후 아래 명령으로 소프트웨어 테스트를 실행합니다. Node.js도 필요합니다.

```powershell
node --test tests/*.test.js
cd backend
.\venv\Scripts\python.exe -m pytest tests/ -q
```

## 문서 안내

아래 상세 가이드는 현재 한국어로 제공합니다.

| 문서 | 내용 |
| --- | --- |
| [아키텍처](ARCHITECTURE.md) | 구성 요소, 데이터 흐름, 현재 구현 범위 |
| [센서 가이드](docs/SENSOR_GUIDE.md) | 펌웨어, 연결, 보정, 문제 해결 |
| [백엔드](backend/README.md) | 설치, API, 인증, DB 업그레이드 |
| [검증 기록](docs/VERIFICATION.md) | 수행한 검사와 남은 실기기 시험 |
| [센서 데이터 정책](docs/backend/04-sensor-data-policy.md) | 입력 출처와 연구 범위 |
