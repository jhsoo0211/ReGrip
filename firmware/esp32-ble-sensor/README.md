# ESP32 BLE 센서 펌웨어

GPIO35 가변저항과 GPIO34 압력 센서를 50Hz로 측정하고, 최신 값을 Bluetooth로 20Hz 전송합니다. 게임 조작에는 압력 센서만 사용합니다. GPIO35는 현재 실제 굽힘 센서 대신 연결한 가변저항입니다.

대상 보드는 `esp32dev`인 ESP32 개발 보드입니다. `platformio.ini`의 플랫폼은 `espressif32@7.0.1`로 고정되어 있습니다.

## 다른 Windows PC에서 준비

Python 3.11과 Python Launcher(`py`), 데이터 전송이 가능한 USB 케이블이 필요합니다. 브라우저 게임은 Bluetooth가 있는 Windows PC의 Chrome 또는 Edge에서 엽니다. 아래 명령은 **ReGrip 저장소 최상위 폴더**의 PowerShell에서 실행합니다.

```powershell
py -3.11 -m venv .tools\pio
.\.tools\pio\Scripts\python.exe -m pip install "platformio==6.1.19"
```

`.tools`는 PC마다 새로 만드는 도구 환경입니다. 기존 PC의 가상환경을 복사할 필요는 없습니다. 첫 빌드에는 플랫폼·컴파일러 다운로드를 위한 인터넷 연결이 필요합니다. 스크립트는 이 환경을 우선 사용하고, 없으면 PATH의 `pio` 또는 `platformio`를 사용합니다. 패키지를 자동 설치하지 않습니다.

## 포트 확인과 업로드

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\flash-sensor.ps1 -ListPorts
```

목록에서 ESP32의 USB-UART 포트를 확인합니다. `COM7`은 아래 명령의 예시이므로 실제 보드 포트로 바꿔 주세요. Bluetooth 가상 COM 포트와 구분하고, 모호하면 보드를 연결하기 전후의 목록을 비교합니다. 다른 프로그램의 시리얼 모니터는 닫습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\flash-sensor.ps1 -Port COM7
```

이 명령은 포트 목록을 조회한 뒤 빌드하고 지정한 포트에 업로드합니다. 존재하지 않는 포트와 Bluetooth 가상 시리얼 포트는 업로드 전에 거절합니다. `-Port`를 생략하면 업로드하지 않으며, 포트를 자동 선택하지 않습니다. PlatformIO의 실패 종료 코드는 호출한 터미널에 그대로 반환합니다.

보드 연결 없이 컴파일만 확인하려면 다음 명령을 사용합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\flash-sensor.ps1 -BuildOnly
```

업로드 성공 후 같은 터미널에서 115200 baud 시리얼 모니터까지 열려면 `-Monitor`를 명시합니다. 기본값은 모니터를 열지 않는 것입니다. 모니터 종료는 `Ctrl+C`입니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\flash-sensor.ps1 -Port COM7 -Monitor
```

## 게임 입력 확인

백엔드 없이 센서 게임을 확인할 수 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev-start.ps1 -LocalOnly -NoBrowser
```

1. `http://localhost:3000/calibration.html`을 열고 **센서 연결 → ReGrip-Sensor**를 선택합니다.
2. 압력 원본값이 손을 쥐고 풀 때 변하는지 확인합니다. 가변저항 값은 진단용입니다.
3. 이완 상태와 편안한 쥐기를 각각 1초씩 기록합니다. 누를수록 ADC가 감소하는 연결도 지원합니다. 두 기준은 64 ADC 이상 떨어져야 하고 각 기록의 P95−P5가 기준 차이의 20% 이하여야 합니다.
4. 운동을 시작합니다. 센서 연결 표시와 보정 완료를 확인하고 실제 센서로 조작합니다. 입력이 500ms 이상 끊기면 게임이 멈추며, 연결 회복 뒤 직접 재개합니다.

업로드 성공은 보드 기록이 끝났다는 뜻입니다. Bluetooth 수신과 실제 손 조작까지는 위 순서로 따로 확인합니다.

## 데이터 형식

| 항목 | 현재 BLE 펌웨어 |
|---|---|
| 장치 이름 | `ReGrip-Sensor` |
| 서비스 UUID | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| 알림 특성 UUID | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |
| Bluetooth 알림 | `timestamp_ms,flex_raw,fsr_raw` — ASCII 3열, 줄바꿈 없음, 최대 20바이트 |
| 시리얼 측정 행 | `sample_id,timestamp_ms,flex_raw,fsr_raw` — 4열, 50Hz, 115200 baud |
| ADC | GPIO35 / GPIO34, 12비트, 0–4095 |

기존 시리얼 전용 스케치와 현재 BLE 펌웨어의 USB 시리얼 출력은 모두 `sample_id,timestamp_ms,flex_raw,fsr_raw` **4열**입니다. Bluetooth 알림은 sample_id를 제외한 **3열**이므로 구분해야 합니다. sample_id는 부팅 후 순서대로 증가하는 uint32 번호입니다. 부팅 메시지, 헤더, `#`로 시작하는 연결 안내는 측정 행이 아닙니다. CSV의 장치 시각이 20ms씩 증가한다고 해서 실제 브라우저 Bluetooth 수신 간격까지 검증된 것은 아닙니다.

PlatformIO 명령 옵션: [빌드·업로드](https://docs.platformio.org/en/latest/core/userguide/cmd_run.html), [포트 목록](https://docs.platformio.org/en/latest/core/userguide/device/cmd_list.html), [시리얼 모니터](https://docs.platformio.org/en/latest/core/userguide/device/cmd_monitor.html).
