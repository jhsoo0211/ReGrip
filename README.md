# ReGrip 🤜

**손 재활을 위한 게이미피케이션 웹 애플리케이션**

ReGrip은 악력 센서와 연동하여 손 재활 훈련을 게임처럼 즐겁게 수행할 수 있도록 설계된 웹 기반 프로토타입입니다. 환자가 지루한 반복 운동 대신 인터랙티브한 미니게임을 통해 재활에 참여하도록 동기를 부여합니다.

---

## 📋 목차

- [주요 기능](#-주요-기능)
- [기술 스택](#-기술-스택)
- [프로젝트 구조](#-프로젝트-구조)
- [시작하기](#-시작하기)
- [센서 연결](#-센서-연결)
- [디자인 시스템](#-디자인-시스템)
- [데이터 저장](#-데이터-저장)

---

## ✨ 주요 기능

### 🎮 재활 미니게임
- **풍선 게임** (`game-balloon.html`): 악력으로 풍선 높이를 조절하여 목표 구간에 유지하는 지속 악력 훈련
- **크레인 게임** (`game-crane.html`): 크레인을 조작하여 캡슐을 수집하는 최대 악력 도달 훈련

### 📊 기록 및 통계
- 훈련 세션 기록 조회 (날짜, 소요 시간, 세트 수, 악력 데이터)
- 세션 클릭 시 세트별 상세 정보 모달
- 주간 평균 악력 차트
- 개인 최고 기록 대시보드

### 🏆 업적 시스템
- 게임 목표 달성 시 배지 획득
- 업적별 상세 정보 모달 (희귀도, 카테고리, 보상 XP)
- 잠긴 업적의 진행률 표시

### 📈 레벨 시스템
- XP 기반 레벨링 (Lv.1 ~ Lv.100)
- 6단계 등급 체계 (입문자 → 마스터)
- 레벨별 보상 미리보기
- XP 획득 내역 조회

### ⚙️ 기타
- **캘리브레이션** (`calibration.html`): 악력 센서 0%~100% 기준 설정
- **프로필 편집** (`profile.html`): 개인 정보, 재활 정보, 훈련 목표 설정
- **설정** (`settings.html`): 기기 연결, 난이도, 알림 관리

---

## 🛠 기술 스택

| 구분 | 기술 |
|------|------|
| **프론트엔드** | HTML5, Vanilla JavaScript, CSS3 |
| **스타일링** | Tailwind CSS (CDN), Vanilla CSS (`shared.css`) |
| **폰트** | Google Fonts — Space Grotesk (제목), DM Sans (본문) |
| **아이콘** | Material Symbols Outlined |
| **데이터 저장** | localStorage (기본) / REST API (전환 가능) |
| **센서 통신** | WebSocket (기본) / Web Serial API (확장 가능) |

---

## 📁 프로젝트 구조

```
Regrip/
├── index.html            # 홈 대시보드 — 인사말, 오늘의 훈련, 주간 목표, 최근 세션
├── training.html         # 훈련 모드 선택 — 풍선/크레인 게임 카드
├── game-balloon.html     # 풍선 게임 — 지속 악력 유지 훈련
├── game-crane.html       # 크레인 게임 — 최대 악력 도달 훈련
├── calibration.html      # 캘리브레이션 — 센서 기준값 설정
├── history.html          # 기록 및 통계 — 세션 로그, 차트, 상세 모달
├── achievements.html     # 업적 — 배지 목록, 상세 모달
├── level.html            # 레벨 상세 — XP 진행, 등급 시스템, 보상
├── profile.html          # 프로필 편집 — 개인/재활 정보, 아바타
├── settings.html         # 설정 — 기기, 훈련, 알림 설정
├── shared.css            # 공유 스타일 — 레트로 디자인 시스템, 네비게이션, 모달
├── shared.js             # 공유 로직 — 네비게이션, DataService, SensorService
└── README.md             # 이 파일
```

---

## 🚀 시작하기

### 요구사항
- 모던 웹 브라우저 (Chrome, Edge, Firefox, Safari)
- (선택) 악력 센서 + WebSocket 서버

### 로컬 실행

별도의 빌드 없이 HTML 파일을 직접 열어 사용할 수 있습니다:

```bash
# 방법 1: 파일을 직접 브라우저에서 열기
open index.html

# 방법 2: 간단한 로컬 서버 실행 (권장)
npx serve .
# 또는
python -m http.server 8000
```

> **참고**: Tailwind CSS는 CDN을 통해 로드되므로 인터넷 연결이 필요합니다.

### 시뮬레이션 모드

실제 센서 없이도 게임을 테스트할 수 있습니다:
- **키보드**: `SPACE` 키를 눌러 악력 시뮬레이션
- **마우스**: 클릭 홀드로 악력 시뮬레이션

---

## 🔌 센서 연결

### 하드웨어 요구사항
- Arduino 또는 Raspberry Pi
- FSR (Force Sensitive Resistor) 센서
- WebSocket 서버 (포트 8080 권장)

### 연결 방법

센서 장치에서 WebSocket 서버를 실행하고, JSON 형식으로 데이터를 전송합니다:

```javascript
// 센서 데이터 형식
{
  "force": 73.5,        // 악력 값 (0~100)
  "timestamp": 1717648200000  // Unix 타임스탬프
}
```

앱에서 연결:

```javascript
// 센서 연결
SensorService.connect('ws://localhost:8080');

// 악력 데이터 수신
SensorService.onForceUpdate(force => {
  console.log('현재 악력:', force, '%');
});

// 연결 해제
SensorService.disconnect();
```

### Arduino 예시 코드

```cpp
#include <WebSocketsServer.h>

WebSocketsServer ws(8080);

void loop() {
  int raw = analogRead(A0);
  float force = map(raw, 0, 1023, 0, 100);
  
  String json = "{\"force\":" + String(force) + 
                ",\"timestamp\":" + String(millis()) + "}";
  ws.broadcastTXT(json);
  delay(50);  // 20Hz
}
```

---

## 🎨 디자인 시스템

ReGrip은 **네오 레트로 (Neo-Retro)** 디자인 스타일을 사용합니다.

### 컬러 팔레트

| 토큰 | 색상 | 용도 |
|------|------|------|
| `--primary` | `#994626` | 메인 브랜드 색상 |
| `--primary-light` | `#e8825e` | 강조 영역 |
| `--bg-app` | `#F0F9FF` | 앱 배경 |
| `--surface` | `#FFF8F6` | 카드/패널 배경 |
| `--ink` | `#0F172A` | 텍스트, 테두리 |
| `--success` | `#16A34A` | 성공/연결 상태 |
| `--error` | `#DC2626` | 오류/경고 |

### 타이포그래피

- **제목**: Space Grotesk (Bold 700)
- **본문**: DM Sans (Regular 400 / Medium 500)
- **라벨**: Space Grotesk (Bold 700, UPPERCASE, letter-spacing: 0.1em+)

### 레트로 유틸리티 클래스

```css
.retro-shadow       /* 4px 4px 0px 오프셋 그림자 */
.retro-shadow-sm    /* 2px 2px 0px 오프셋 그림자 */
.retro-border       /* 2px solid 테두리 */
.retro-border-thick /* 4px solid 테두리 */
```

### 반응형 레이아웃

- **데스크톱** (≥768px): 240px 사이드바 내비게이션
- **모바일** (<768px): 하단 고정 탭 바 내비게이션

---

## 💾 데이터 저장

### 기본: localStorage

모든 데이터는 브라우저의 `localStorage`에 저장됩니다:

| 키 | 내용 |
|----|------|
| `regrip_profile` | 프로필 정보 (이름, 나이, 재활 정보 등) |
| `regrip_sessions` | 훈련 세션 배열 |
| `regrip_settings` | 앱 설정 (손, 난이도, 휴식 시간) |

### REST API로 전환

`DataService`는 REST API 백엔드로 쉽게 전환할 수 있습니다:

```javascript
// REST 모드로 전환
DataService.setBackend('rest', 'https://api.yourserver.com');

// 이후 모든 데이터 호출이 API를 통해 이루어짐
const profile = await DataService.getProfile();
await DataService.saveProfile({ name: '홍길동', ... });
```

---

## 📝 Git Commit Convention

```
<Type>: <설명>
```

|Type|설명|
|---|---|
|**Feat**|새로운 기능 추가|
|**Fix**|버그 수정|
|**Refactor**|리팩토링|
|**Design**|UI 변경|
|**Comment**|주석|
|**Style**|포맷팅 (로직 변경 X)|
|**Test**|테스트 코드|
|**Chore**|빌드 / 패키지 / 기타|
|**Init**|초기 생성|
|**Rename**|파일·폴더 이동|
|**Remove**|파일 삭제|

---


## 📄 라이선스

이 프로젝트는 교육 및 연구 목적의 프로토타입입니다.

---

<p align="center">
  <strong>ReGrip</strong> — 재활을 게임처럼, 회복을 즐겁게 🎮
</p>
