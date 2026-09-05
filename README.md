# ReGrip

[English](README.md) | [한국어](README.ko.md)

A web prototype that turns grip-pressure input into games, training records, and progress feedback for home hand rehabilitation.

Play four games with an ESP32 pressure sensor or try them with keyboard and on-screen controls. Training results stay in the browser; an optional FastAPI backend adds accounts and server synchronization. The application UI is currently in Korean.

## Features

- **Four training games:** balloon, crane, rhythm, and submarine, with adjustable difficulty and a short practice mode.
- **Sensor connection and calibration:** browser BLE support for ESP32 FSR input, personal pressure calibration, and a diagnostic graph. Legacy WebSocket input is also supported.
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

Use Windows Chrome or Edge on HTTPS or localhost. Follow the [sensor guide](docs/SENSOR_GUIDE.md) to build and upload the BLE firmware, connect the device, and calibrate relaxed and comfortable-grip pressure.

Games use the **FSR pressure channel**. The second channel is a potentiometer used to simulate flex input for diagnostics. Sensor input is processed in the browser; the backend is optional for this path too.

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

This work provides ingestion, training, and visualization code for exploring a future EMG extension. **The trained EMG model is not connected to the current FSR-controlled games**; the result does not measure performance on new users or clinical outcomes.

The repository includes scripts and summary figures. Raw downloads, processed signal files, and local training outputs are not committed. Obtain the source data through NinaPro and follow its access and citation requirements.

See the [experiment report](docs/backend/09-ml-training.md) for variable handling, evaluation, figures, and reproduction steps; the [signal catalog](docs/backend/08-signal-catalog.md) explains storage and ingestion. These detailed notes include historical decisions; [Architecture](ARCHITECTURE.md) defines the current product integration.

## Tech stack

| Layer | Technologies |
| --- | --- |
| Web app | HTML, CSS, Vanilla JavaScript, Tailwind CSS |
| Games and diagnostics | DOM/SVG, requestAnimationFrame, Canvas diagnostic graphs |
| Backend | Python 3.11, FastAPI, SQLAlchemy, Pydantic |
| Storage | localStorage, SQLite; PostgreSQL migrations provided |
| Device | ESP32, Arduino, PlatformIO, BLE; legacy Wi-Fi WebSocket |

## Validation status

The [verification record](docs/VERIFICATION.md), dated September 5, 2026, reports **71 frontend tests**, **145 backend tests**, a successful BLE firmware build, and checks for local server startup and the SQLite upgrade.

Physical ESP32 upload and wireless operation, real-browser interaction and visual checks, and PostgreSQL execution remain to be verified. This is a development prototype; clinical effectiveness has not been established. The separate EMG research code is not integrated into the games.

To run the software tests after setting up the backend (Node.js is also required):

```powershell
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
