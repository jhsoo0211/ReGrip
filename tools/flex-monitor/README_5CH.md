# Re:Grip 5채널 플렉스 센서 USB·BLE 모니터

## 구성

- 펌웨어: [`firmware/xiao-glove/regrip_sensor_pcb_5ch/regrip_sensor_pcb_5ch.ino`](../../firmware/xiao-glove/regrip_sensor_pcb_5ch/regrip_sensor_pcb_5ch.ino)
- 화면: `regrip-flex-monitor.html`
- 파서: `regrip-flex-core.mjs`
- 로컬 서버: `server.mjs`

## 실행

1. XIAO에 5채널 펌웨어를 업로드한다.
2. Arduino IDE의 Serial Monitor 등 COM 포트를 점유하는 프로그램을 닫는다.
3. `start-flex-monitor.cmd`를 더블클릭한다.
4. Chrome 또는 Edge에서 연결 방법을 선택한다.

Node.js가 필요하다. 다른 터미널에서는 이 폴더에서 `node server.mjs`를 실행하고 <http://127.0.0.1:8080/regrip-flex-monitor.html>을 연다. 저장소의 3000번 정적 서버(Python `http.server`)는 Windows에서 `.mjs`를 JavaScript로 보내지 않을 수 있어 이 모니터에는 쓰지 않는다. `file://`로 직접 열면 Web Bluetooth와 모듈 로딩이 동작하지 않는다.

### USB로 연결

1. **USB 센서 연결**을 누른다.
2. 목록에서 `USB JTAG/serial debug unit (COM9)` 또는 XIAO에 해당하는 포트를 선택한다.

USB는 100 Hz로 수신하며, 다른 프로그램이 COM 포트를 열고 있으면 브라우저가 연결할 수 없다.

### Bluetooth LE로 연결

1. XIAO에 전원을 공급하고 Windows Bluetooth를 켠다.
2. **BLE 센서 연결**을 누른다.
3. 브라우저가 표시하는 목록에서 `ReGrip-5CH`를 선택하고 **페어링**을 누른다.

BLE는 100 Hz를 목표로 수신한다. Windows용 Chrome 또는 Edge에서 `localhost` 주소로 실행해야 하며, Windows 설정에서 미리 페어링할 필요는 없다. 실제 수신 속도는 Windows가 협상한 BLE 연결 간격과 브라우저 상태에 따라 달라질 수 있다.

USB와 BLE 펌웨어는 동시에 동작하지만 모니터 화면에서는 둘 중 하나를 골라 연결한다. 화면을 닫은 후에는 실행된 명령 프롬프트 창도 닫아 로컬 서버를 종료한다.

## 정상 기준

- 연결된 플렉스 센서: 중간 범위 값이며 굽힐 때 값이 증가한다.
- 미연결 채널: 4095 근처이며 화면에 `미연결`로 표시된다.
- 수신 속도: USB와 BLE 모두 목표 약 100 Hz.
- 펴짐·굽힘 기준을 모두 저장하면 손가락별 0~100% 값이 표시된다.
