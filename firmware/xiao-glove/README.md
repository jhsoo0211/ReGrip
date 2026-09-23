# XIAO ESP32-S3 five-finger glove

Reads five analog sensor signals without generating simulated input. Each sensor needs a suitable voltage-divider circuit, shared ground, and a signal within the board's ADC voltage limits.

| Finger | XIAO pin | GPIO |
|---|---|---|
| Thumb | D0 | 1 |
| Index | D1 | 2 |
| Middle | D3 | 4 |
| Ring | D4 | 5 |
| Little | D5 | 6 |

D2 is unused. D4/D5 are analog inputs here, not an I2C bus. The mapping follows the user's glove wiring and the [Seeed pinout](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/).

## Build and upload

Use PlatformIO 6.1.19 with the pinned Espressif32 7.0.1 platform. The [PlatformIO board ID](https://docs.platformio.org/en/latest/boards/espressif32/seeed_xiao_esp32s3.html) is `seeed_xiao_esp32s3`. From the repository root, prepare a local tool environment once:

```powershell
py -3.11 -m venv .tools/pio
.\.tools\pio\Scripts\python.exe -m pip install "platformio==6.1.19"
```

Build without opening a device:

```powershell
.\.tools\pio\Scripts\python.exe -m platformio run --project-dir firmware/xiao-glove -e seeed_xiao_esp32s3
```

List ports, identify the XIAO USB port, then upload explicitly:

```powershell
.\.tools\pio\Scripts\python.exe -m platformio device list --serial
.\.tools\pio\Scripts\python.exe -m platformio run --project-dir firmware/xiao-glove -e seeed_xiao_esp32s3 -t upload --upload-port COM4
```

Replace COM4 with the board's actual USB port and close any serial monitor before uploading. `scripts/flash-sensor.ps1` remains the uploader for the older ESP32 FSR board; it does not select this firmware.

## Transport

- USB: 115200 baud, nominal 50 Hz, `sample_id,timestamp_ms,thumb_raw,index_raw,middle_raw,ring_raw,little_raw`.
- BLE: `ReGrip-Sensor`, existing Nordic UART service and TX UUID, nominal 20 Hz.
- BLE packet: exactly 18 bytes. Bytes 0–3 are `52 47 01 05` (hex); bytes 4–7 hold a little-endian uint32 timestamp; bytes 8–17 hold five little-endian uint16 ADC readings in the table's order. Every reading must be 0–4095.
- USB logging never blocks sampling when a serial monitor is absent.

The browser displays all five channels. Game input is the arithmetic mean of these raw channels, normalized using actual open-hand and comfortable-grip captures. Calibration and saved session provenance use `channel: finger_mean`; the readings are not labeled as FSR pressure, physical force, or finger angles. Both increasing and decreasing aggregate polarity are supported. Sensors with opposing polarities require a different per-finger calibration model.

Build/tests alone do not demonstrate physical sensor response. Confirm that each displayed channel follows the corresponding finger before calibrating and playing.
