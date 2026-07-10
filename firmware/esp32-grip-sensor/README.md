# ReGrip ESP32 Grip Sensor Firmware

![status](https://img.shields.io/badge/status-%ED%95%98%EB%93%9C%EC%9B%A8%EC%96%B4%20%EC%8B%A4%EA%B8%B0%20%EA%B2%80%EC%A6%9D%20%EC%A0%84-orange)
![framework](https://img.shields.io/badge/framework-Arduino%20(ESP32)-blue)
![transport](https://img.shields.io/badge/transport-WiFi%20WebSocket%20:8080-success)

> ⚠️ **하드웨어 실기 검증 전 (pre-hardware)**
> 이 펌웨어는 실제 ESP32 + FSR 보드에서 아직 검증되지 않은 프로토타입입니다.
> API 시그니처는 라이브러리 헤더 기준으로 정확하게 작성했으나, 배선·ADC 특성·타이밍은
> 실기 테스트로 확인해야 합니다(하단 [실기 체크리스트](#-실기-테스트-체크리스트) 참조).

ReGrip 웹앱의 악력 센서 기기 펌웨어입니다. FSR(Force Sensitive Resistor)로 악력을 읽어
로컬 네트워크에서 **WebSocket 서버(포트 8080)** 를 구동하고, 브라우저가
`ws://<esp32-ip>:8080` 으로 접속해 20Hz JSON 스트림을 수신합니다.

- 전송 정책 근거: [`docs/backend/04-sensor-data-policy.md`](../../docs/backend/04-sensor-data-policy.md) — **ADR-04-0 (WiFi WebSocket 우선)**
- 브라우저 수신 계약: [`shared.js`](../../shared.js) — `SensorService.connect()`

### 데이터 계약

ESP32 → 브라우저, 20Hz JSON 브로드캐스트:

```json
{ "force": 73.5, "timestamp": 1717648200000 }
```

| 필드 | 타입 | 의미 |
|------|------|------|
| `force` | float `0~100` (소수 1자리) | **원시 스케일** 악력 값. 0%~100% 캘리브레이션은 **웹앱**이 수행합니다(펌웨어는 원시값만 전송). |
| `timestamp` | unsigned long | `millis()` — 부팅 후 경과 ms. 프론트 `SensorService`는 `force`만 사용하므로 Unix epoch일 필요 없음. |

> **캘리브레이션은 앱이 수행합니다.** 펌웨어는 `raw / 4095 * 100` 원시 스케일만 보내고,
> 앱의 **캘리브레이션 화면**(`calibration.html`)이 `baseline0`/`baseline100` 기준으로 0~100%를
> 정규화합니다(`SensorService._normalize`). 펌웨어에서 별도 보정을 하지 마세요.

---

## 🧰 부품 목록 (BOM)

| 부품 | 사양 | 비고 |
|------|------|------|
| ESP32 DevKit | ESP32-WROOM-32 등 (`board = esp32dev`) | WiFi 내장 MCU, 온보드 LED(GPIO2) |
| FSR 센서 | Force Sensitive Resistor (예: FSR402, Interlink 0.5") | 악력 감지 소자 |
| 저항 | 10kΩ (1/4W) | 분압(pull-down) 저항 |
| 점퍼 와이어 | 3가닥 | 3V3 / GPIO34 / GND |
| (선택) 브레드보드 | — | 프로토타이핑 |

---

## 🔌 배선도 (Wiring)

FSR + 10kΩ 로 **분압 회로**를 구성합니다. FSR을 세게 누를수록 저항이 낮아져
GPIO34의 전압(=`analogRead` 값)이 3V3 쪽으로 올라갑니다 → force% 증가.

```
        3V3
         │
      ┌──┴──┐
      │ FSR │   (악력 → 저항 감소)
      └──┬──┘
         │
         ├───────────────►  GPIO34  (ADC1_CH6, 입력 전용)
         │
      ┌──┴──┐
      │ 10kΩ│   (pull-down)
      └──┬──┘
         │
        GND
```

- **FSR 한쪽 다리 → 3V3**
- **FSR 다른쪽 다리 → 분기점**: (a) **GPIO34** 로 연결, (b) **10kΩ 저항 → GND**
- GPIO34는 **ADC1 채널·입력 전용**이라 내부 풀업/풀다운이 없습니다 → 외부 10kΩ 필수.
- ADC2 핀(GPIO0, 2, 4, 12~15, 25~27)은 **WiFi 사용 시 충돌**하므로 피하고, ADC1(32~39)을 사용합니다. GPIO34가 적합합니다.

> 힘–값 스케일은 FSR 특성상 비선형입니다. 절대적 선형성이 목적이 아니라,
> 앱 캘리브레이션이 개인별 최소/최대를 잡아주므로 분압 회로면 충분합니다.

---

## 🚀 플래시 절차

### A. PlatformIO (권장)

1. **설정 파일 준비** — WiFi 자격증명 입력:
   ```bash
   cd firmware/esp32-grip-sensor
   cp include/config.h.example include/config.h
   # include/config.h 를 열어 WIFI_SSID / WIFI_PASS 를 채웁니다.
   ```
   > `config.h` 가 없으면 빌드가 `#error` 로 중단되며 복사 안내가 출력됩니다.

2. **빌드 & 업로드** (ESP32를 USB로 연결):
   ```bash
   pio run -t upload
   ```
   `links2004/WebSockets@^2.4` 의존성은 자동으로 내려받습니다(`platformio.ini`).

3. **시리얼 모니터** — 접속용 IP 확인:
   ```bash
   pio device monitor -b 115200
   ```

### B. Arduino IDE (대안)

1. **보드 지원**: 보드 매니저에서 **esp32 by Espressif Systems** 설치 → 보드를 "ESP32 Dev Module" 선택.
2. **라이브러리**: 라이브러리 매니저에서 **"WebSockets" by Markus Sattler** 설치
   (= links2004/arduinoWebSockets, 이 프로젝트가 사용하는 것과 동일).
3. **스케치 구성**:
   - 스케치 폴더(예: `esp32-grip-sensor/`)를 만들고 `src/main.cpp` 를 **`esp32-grip-sensor.ino`** 로 복사(이름을 폴더명과 동일하게).
   - `include/config.h.example` 를 같은 폴더에 **`config.h`** 로 복사해 WiFi 정보 입력.
4. 보드/포트 선택 후 **업로드**. 시리얼 모니터 속도 **115200** 으로 IP 확인.

> Arduino IDE에서도 `#include "config.h"` 는 스케치 폴더에서 해결되며,
> `__has_include` 는 최신 ESP32 코어(GCC)에서 지원됩니다.

---

## 🌐 웹앱 연결 방법

1. 시리얼 모니터(115200)에서 부팅 로그의 **IP 주소**를 확인합니다. 예:
   ```
   [WiFi] STA 접속 성공. IP: 192.168.0.42
   [APP] 브라우저 콘솔/설정에 입력:
         SensorService.connect('ws://192.168.0.42:8080')
   [APP] 또는 mDNS: ws://regrip-sensor.local:8080
   ```
2. ReGrip 웹앱을 **같은 네트워크**의 브라우저에서 엽니다.
3. 앱의 **설정 화면**(`settings.html`)의 기기 연결, 또는 브라우저 **콘솔**에서 직접:
   ```javascript
   SensorService.connect('ws://192.168.0.42:8080');   // 시리얼에서 본 IP
   // 또는 mDNS 지원 환경:
   SensorService.connect('ws://regrip-sensor.local:8080');

   SensorService.onForceUpdate(f => console.log('force:', f));
   ```
4. 연결되면 온보드 LED가 **빠르게 점멸**하고, 시리얼에 `[WS] 클라이언트 #0 연결됨` 이 찍힙니다.

> `SensorService`는 끊기면 3초마다 자동 재연결하고, force 값에 앱 캘리브레이션을 적용합니다.

---

## 📶 SoftAP 모드 사용법 (공유기 없는 환경)

WiFi STA 접속이 **15초 안에 2회** 실패하면 ESP32가 자동으로 **자체 AP**가 됩니다:

| 항목 | 값 |
|------|-----|
| SSID | `ReGrip-Sensor` |
| 암호 | `regrip1234` |
| ESP32 IP | `192.168.4.1` (기본) |

사용 순서:

1. 태블릿/노트북의 WiFi를 **`ReGrip-Sensor`** 에 접속(암호 `regrip1234`).
2. 브라우저에서:
   ```javascript
   SensorService.connect('ws://192.168.4.1:8080');
   ```
3. 훈련 페이지는 **로컬(파일 또는 http)** 로 열어야 합니다(아래 mixed content 참고).

> SoftAP 모드에서는 인터넷이 없으므로 Tailwind CDN 등 외부 리소스가 로드되지 않을 수 있습니다.
> 오프라인 훈련 자체는 로컬 처리 모델(ADR-04-1)로 가능합니다.

---

## 🛠 트러블슈팅

### 1. Mixed content — `ws://` 가 차단됨
`https://` 로 서빙되는 페이지는 브라우저 보안 정책상 비보안 `ws://` 연결을 **차단**합니다.
- 해결: 훈련 페이지를 **`http://localhost`** 또는 **`file://`** 등 **비보안(또는 로컬) 컨텍스트**로 열어야 합니다.
  ```bash
  # 프로젝트 루트에서
  python -m http.server 8000   # → http://localhost:8000/settings.html
  ```
- 정식 배포 시 연결 전략(로컬 헬퍼/게이트웨이)은 ADR-04-0 "주의(Constraints)" 참조.

### 2. 연결이 안 됨 — 같은 네트워크 확인
- ESP32와 브라우저 기기가 **동일한 공유기/서브넷**에 있어야 합니다(STA 모드).
- 방화벽/게스트망 격리(AP isolation)가 켜져 있으면 포트 8080 접속이 막힙니다.
- `ws://regrip-sensor.local` 이 안 되면 IP로 직접 접속하세요(일부 OS는 mDNS 미지원).

### 3. ADC 노이즈 / 값이 튐
- 이미 **5샘플 이동평균**으로 스무딩하지만, 배선이 길거나 접촉이 불안정하면 값이 흔들립니다.
- 대책: 짧고 단단한 배선, FSR 접점 안정화, 필요 시 GPIO34–GND 사이 **0.1µF 커패시터**로 추가 필터링.
- ADC 풀 스케일 근처(3V3 부근)는 ESP32 ADC 특성상 약간 **비선형/포화**합니다 — 앱 캘리브레이션이 흡수합니다.
- 값이 항상 0 이거나 최대면 배선(분압 방향)·핀 번호(`FSR_PIN`)를 재확인하세요.

### 4. 빌드 에러 `config.h 를 찾을 수 없습니다`
- `include/config.h.example` → `include/config.h` 복사를 빠뜨린 경우입니다(정상 안내).

---

## 🧪 실기 테스트 체크리스트

실제 하드웨어에서 다음을 순서대로 확인하세요:

- [ ] `config.h` 작성 후 빌드/업로드 성공(라이브러리 자동 설치 확인).
- [ ] 부팅 배너 + IP 주소가 시리얼(115200)에 출력됨.
- [ ] STA 접속 성공 시 LED **느린 점멸 → 켜짐**, 실패 시 SoftAP(`ReGrip-Sensor`)로 폴백.
- [ ] `ws://<ip>:8080` 접속 시 `[WS] 클라이언트 연결됨` 로그 + LED **빠른 점멸**.
- [ ] 브라우저 콘솔에서 `SensorService.onForceUpdate`로 20Hz 근처 수신 확인(1초에 ~20건).
- [ ] JSON 형식이 계약과 일치: `{"force":<0~100 소수1자리>,"timestamp":<millis>}`.
- [ ] FSR을 세게 쥘수록 `force` **증가**, 놓으면 감소(분압 방향 정상).
- [ ] force 범위가 대략 0~100에 걸침(안 걸리면 저항값/attenuation 조정 검토).
- [ ] 클라이언트 0명일 때 브로드캐스트 생략(불필요 트래픽 없음).
- [ ] 클라이언트 연결 유지 상태에서 장시간(수 분) force 스트림 끊김/재연결 동작 확인.
- [ ] mDNS `regrip-sensor.local` 로 접속 가능한지(지원 OS에서).
- [ ] 앱 캘리브레이션 화면에서 min/max 설정 후 게임(`game-balloon`/`game-crane`) 반응 확인.

---

## 📁 파일 구조

```
firmware/esp32-grip-sensor/
├── platformio.ini          # env:esp32dev, framework=arduino, lib_deps=links2004/WebSockets
├── src/
│   └── main.cpp            # 펌웨어 본체
├── include/
│   ├── config.h.example    # 설정 템플릿 → config.h 로 복사
│   └── config.h            # (gitignore) 로컬 WiFi 자격증명
├── .gitignore
└── README.md               # 이 파일
```
