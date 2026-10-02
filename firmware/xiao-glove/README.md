# Re:Grip Sensor PCB 5채널 펌웨어 (XIAO ESP32-S3)

팀에서 실기기로 검증한 USB·BLE 병행 펌웨어입니다. [`regrip_sensor_pcb_5ch/regrip_sensor_pcb_5ch.ino`](regrip_sensor_pcb_5ch/regrip_sensor_pcb_5ch.ino)는 전달받은 원본과 바이트 단위로 같으며, 검증 범위를 유지하기 위해 이 저장소에서 수정하지 않았습니다.

팀 검증 기록: Arduino ESP32 core 3.3.11 컴파일 성공, XIAO ESP32-S3 실기기 업로드 성공, USB 측정 간격 10ms 확인, 웹 파서 단위 테스트 통과. 이전의 D0·D1·D3·D4·D5 배선용 v1(18바이트) 펌웨어는 실기기 검증 없이 대체되어 삭제했습니다.

## 대상과 배선

- Seeed Studio XIAO ESP32-S3 / ESP32-S3 Sense 본체
- Re:Grip Sensor PCB Rev B2/B3
- 각 ADC 입력은 47 kOhm으로 3.3 V에 풀업되고, J1-1이 공통 GND입니다.

| 손가락 | XIAO 핀 | PCB 커넥터 |
|---|---|---|
| 엄지 | D0 | J1-6 |
| 검지 | D1 | J1-5 |
| 중지 | D2 | J1-4 |
| 약지 | D3 | J1-3 |
| 소지 | D4 | J1-2 |

센서를 연결하지 않은 채널은 풀업 때문에 4095 근처가 정상입니다. 센서를 연결하면 중간값이 나오며, 현재 회로 방향에서는 굽힐수록 값이 증가합니다.

## 빌드와 업로드 (Arduino IDE)

팀 검증 환경은 **Arduino ESP32 core 3.3.11**입니다. `regrip_sensor_pcb_5ch` 폴더를 스케치로 엽니다.

- Board: `XIAO_ESP32S3`
- USB CDC On Boot: `Enabled`
- Upload Mode: `UART0 / Hardware CDC` 계열 기본값
- Serial Monitor: `115200 baud`

이 스케치는 core 3.x의 `BLEServer::requestConnParams`를 사용합니다. 저장소의 다른 PlatformIO 프로젝트가 고정한 `espressif32@7.0.1`(Arduino core 2.0.17)에는 이 API가 없으므로 그 환경으로는 빌드하지 않습니다.

## 출력 형식

| 경로 | 계약 |
|---|---|
| USB 시리얼 | 115200 baud, 목표 100Hz CSV `sample_id,timestamp_ms,thumb_raw,index_raw,middle_raw,ring_raw,little_raw`, `#`으로 시작하는 상태 줄 |
| BLE 장치 이름 | `ReGrip-5CH` (서비스 UUID를 광고) |
| Service UUID | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| Notify UUID | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |
| BLE 전송 | 목표 100Hz, 연결 간격 7.5~15ms 요청 |
| BLE 패킷 | protocol v3, 20바이트 little-endian |

| 바이트 | 내용 |
|---|---|
| 0 | magic `0x52` (`R`) |
| 1 | 프로토콜 버전 `3` |
| 2–3 | uint16 sample id (65535 다음 0) |
| 4–7 | uint32 `millis()` 시각 |
| 8–17 | uint16 ADC 5개, 엄지→소지 순서, 0~4095 |
| 18 | 연결 채널 비트마스크 (bit0=엄지, 값 < 4090이면 연결) |
| 19 | 오류 코드, 현재 0으로 예약 |

USB CSV는 BLE 연결 여부와 관계없이 계속 출력됩니다. Windows와 브라우저가 실제 BLE 연결 간격을 결정하므로 BLE 수신 속도는 100Hz보다 낮을 수 있습니다.

## 웹 앱과 진단 도구

- 게임 앱(`sensor-service.js`)은 위 서비스 UUID로 장치를 찾고 v3 패킷을 해석합니다. 다섯 원본값을 진단 화면에 표시하고, **다섯 값의 산술평균**을 손 펴기·편안한 쥐기 기준으로 보정해 게임 입력으로 씁니다. 미연결 채널(4095 근처)도 평균에 포함되며, 보정은 같은 연결 상태를 기준으로 합니다. 보정·세션의 `channel`은 `finger_mean`이며 압력·관절 각도 측정값이 아닙니다.
- 채널별 값, USB 수신, 손가락별 캘리브레이션과 CSV 기록은 팀 검증 모니터 [`tools/flex-monitor`](../../tools/flex-monitor/README_5CH.md)로 확인합니다.

빌드·테스트 통과만으로 물리 센서 반응을 증명하지는 않습니다. 보정과 게임 전에 각 채널이 해당 손가락을 따라 움직이는지 확인합니다.
