# ReGrip

[English](README.md) | [한국어](README.ko.md)

A web prototype that turns hand-sensor input into games, training records, and progress feedback for home hand rehabilitation.

Play four games with an ESP32 FSR pressure sensor or a XIAO ESP32-S3 five-finger glove, or try them with keyboard and on-screen controls. Training results stay in the browser; an optional FastAPI backend adds accounts and server synchronization. The application UI is currently in Korean.

Updated September 23, 2026. The existing application design is preserved; `design-review/` contains reference mockups.

## Features

- **Four training games:** balloon, crane, rhythm, and submarine, with adjustable difficulty and a short practice mode.
- **Sensor connection and calibration:** browser BLE support for ESP32 FSR or five-finger glove input, personal calibration, and diagnostic graphs. Legacy WebSocket input is also supported.
- **Pause and resume:** games pause when sensor data stops or the tab is hidden, then wait for the user to resume.
- **Training history and rewards:** scores, session history, statistics, XP, levels, and achievements. Sensor and simulation records are labeled separately.
- **Local storage and sync:** preserve completed sessions locally, retry failed uploads, and prevent duplicate records and rewards. Data is separated by account and API endpoint.

## Quick start

### Try without a sensor

Requires Git and Python. The commands below use Windows PowerShell and Python 3.11.

```powershell
git clone https://github.com/jhsoo0211/ReGrip.git
cd ReGrip
py -3.11 -m http.server 3000 --bind 127.0.0.1
```

Open [localhost:3000](http://localhost:3000), choose a game, and select **시뮬레이션 사용** (Use simulation). Use **Space** or the on-screen press button. Practice lasts up to 20 seconds and does not save a session or award XP.

The frontend needs no build step or backend for simulation and local records. Tailwind and some fonts load from CDNs, so the first page load requires internet access.

### Connect an ESP32 sensor

Use Windows Chrome or Edge on HTTPS or localhost. Follow the [sensor guide](docs/SENSOR_GUIDE.md) to build and upload the BLE firmware, connect the device, and calibrate open-hand and comfortable-grip input.

The original board uses the **FSR pressure channel** for games; its second potentiometer channel is diagnostic only. The team-verified [XIAO ESP32-S3 sensor PCB](firmware/xiao-glove/README.md) (`ReGrip-5CH`, 100 Hz) connects over **Bluetooth or a USB cable**. The calibration page shows each finger D0–D4 with its receive rate, calibrates every finger separately, and lets you choose which fingers drive the game (all calibrated fingers by default); game input is the mean bend of the selected fingers. Its sessions record `inputSource: ble` or `usb` with a per-finger `channel: finger_flex` snapshot, distinct from FSR pressure; the values are not physical force or finger angles. Sensor input is processed in the browser; the backend is optional for both paths.

For the original FSR board, prepare the [PlatformIO environment](firmware/esp32-ble-sensor/README.md), then run from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\flash-sensor.ps1 -ListPorts
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\flash-sensor.ps1 -Port COM7
```

Replace COM7 with the actual USB port. Use `-BuildOnly` instead of `-Port COM7` to compile without a board. The XIAO sensor PCB firmware is uploaded with the Arduino IDE (ESP32 core 3.3.11) as described in its README; the [5-channel monitor](tools/flex-monitor/README_5CH.md) checks each channel over USB or BLE. The [CSV replay guide](docs/SENSOR_GUIDE.md#측정-csv로-게임-입력-재현) covers the original FSR board's 3/4-column recordings; the glove's 7-column USB logs are not supported by that replay tool.

### Enable accounts and server sync

From the repository root, install the backend dependencies:

```powershell
py -3.11 -m venv backend/venv
.\backend\venv\Scripts\python.exe -m pip install -r backend/requirements.txt
```

If you have an existing SQLite database, stop the API and follow the [database upgrade instructions](backend/README.md) before starting. Keep the existing database; the upgrade tool creates a backup and preserves records.

Stop the standalone frontend server from the first step, then run:

```powershell
.\scripts\dev-start.ps1
# Stop both servers:
.\scripts\dev-stop.ps1
```

- App: [localhost:3000](http://localhost:3000)
- API documentation: [localhost:8000/docs](http://localhost:8000/docs)

See the [backend README](backend/README.md) for configuration and database setup.

## Research data and machine learning

The repository also contains an offline hand-gesture classification study using [NinaPro DB2](https://ninapro.hevs.ch/instructions/DB2.html), described by [Atzori et al. (2014)](https://www.nature.com/articles/sdata201453).

| Item | Use in ReGrip |
| --- | --- |
| Dataset | The experiment record reports 40 subjects and 120 recordings imported into a signal catalog. |
| Processing | Store signal arrays separately from metadata; use refined movement and repetition labels to build training samples. |
| Model | Extract 60 time-domain features from 12-channel EMG and classify 49 gestures with RandomForest. Train and test on different repetitions within each subject. |
| Recorded result | Mean subject-level test accuracy: **73.5% ± 7.0%** (standard deviation), as reported in the [experiment report](docs/backend/09-ml-training.md). |

This work provides ingestion, training, and visualization code for exploring a future EMG extension. **The trained EMG model is not connected to the current FSR- or glove-controlled games**; the result does not measure performance on new users or clinical outcomes.

The repository includes scripts and summary figures. Raw downloads, processed signal files, and local training outputs are not committed. Obtain the source data through NinaPro and follow its access and citation requirements.

See the [experiment report](docs/backend/09-ml-training.md) for variable handling, evaluation, figures, and reproduction steps; the [signal catalog](docs/backend/08-signal-catalog.md) explains storage and ingestion. These detailed notes include historical decisions; [Architecture](ARCHITECTURE.md) defines the current product integration.

## Tech stack

| Layer | Technologies |
| --- | --- |
| Web app | HTML, CSS, Vanilla JavaScript, Tailwind CSS |
| Games and diagnostics | DOM/SVG, requestAnimationFrame, Canvas diagnostic graphs |
| Backend | Python 3.11, FastAPI, SQLAlchemy, Pydantic |
| Storage | localStorage, SQLite; PostgreSQL migrations provided |
| Device | ESP32 FSR board / XIAO ESP32-S3 glove, Arduino, PlatformIO, BLE; legacy Wi-Fi WebSocket |

## Validation status

The [verification record](docs/VERIFICATION.md), updated October 2, 2026, reports **142 frontend tests** and **190 backend tests** passing, including byte- and line-level cross-checks of the app's BLE and USB parsers against the team-verified sensor PCB monitor, and a headless browser run of USB connect → per-finger calibration → game play with a simulated serial port. Earlier records cover the original ESP32 firmware, local server startup, and the SQLite upgrade.

On September 6, the original ESP32 board was flashed and its USB/BLE transport and reconnection were checked without attached sensors. Chrome game checks used synthetic GATT input. The team verified the XIAO sensor PCB firmware on hardware; connecting that board to this app for a complete Chrome/Edge session with real hand input, and PostgreSQL execution, remain to be verified. This is a development prototype; clinical effectiveness has not been established. The server recalculates rewards but does not authenticate sensor input. The separate EMG research code is not integrated into the games.

To run all software tests after setting up the backend (Node.js is also required), install the optional ingestion-test dependencies first:

```powershell
.\backend\venv\Scripts\python.exe -m pip install -r backend/requirements-ingest.txt
node --test tests/*.test.js
cd backend
.\venv\Scripts\python.exe -m pytest tests/ -q
```

## Documentation

The detailed guides below are currently in Korean.

| Guide | Contents |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | Components, data flow, and implementation boundaries |
| [Sensor guide](docs/SENSOR_GUIDE.md) | Firmware, connection, calibration, and troubleshooting |
| [Backend](backend/README.md) | Installation, API, authentication, and database upgrades |
| [Verification](docs/VERIFICATION.md) | Recorded checks and remaining hardware tests |
| [Sensor data policy](docs/backend/04-sensor-data-policy.md) | Input provenance and research boundaries |
