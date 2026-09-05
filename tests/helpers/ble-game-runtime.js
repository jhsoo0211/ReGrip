'use strict';
const assert = require('node:assert/strict');
const { createSensorService, SERVICE_UUID, TX_UUID } = require('../../sensor-service');
const { runtime } = require('./game-runtime');

// Deterministic synthetic BLE transport for production SensorService + GameShell + page scripts.
// DOM, clock, GATT, and final persistence are boundaries; game/force algorithms are not mocked.
// Raw captures are caller-owned: notifyRaw preserves a supplied firmware timestamp.
const REST_RAW = 4095;
const SQUEEZE_RAW = 300;
const WALL_TIME = '2026-09-05T00:00:00.000Z';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const rawFor = percent => Math.round(REST_RAW + (SQUEEZE_RAW - REST_RAW) * percent / 100);

function clockBoundary() {
  let time = 10000, sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay = 0) {
      const id = ++sequence;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

function bleBoundary() {
  const device = new EventTarget(), characteristic = new EventTarget();
  device.id = 'synthetic-board';
  device.name = 'ReGrip-Sensor';
  characteristic.startNotifications = async () => characteristic;
  characteristic.stopNotifications = async () => characteristic;
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    async getPrimaryService(service) {
      assert.equal(service, SERVICE_UUID);
      return { async getCharacteristic(tx) { assert.equal(tx, TX_UUID); return characteristic; } };
    },
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  return {
    device,
    navigator: { bluetooth: {
      requestDevice(options) {
        assert.deepEqual(options, { filters: [{ name: 'ReGrip-Sensor' }], optionalServices: [SERVICE_UUID] });
        return Promise.resolve(device);
      },
      getDevices: async () => [device],
    } },
    send(csv) {
      characteristic.value = new DataView(new TextEncoder().encode(csv).buffer);
      characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    },
  };
}

/**
 * createBleGameRuntime(game, { baseline0, baseline100, settings, wallTime })
 *
 * connect/calibrate/start establish a synthetic bench session through the real
 * public service methods (including the 2.1s countdown). tick/feed send raw ADC
 * at 20Hz. finish invokes the page's normal result builder, then GameShell.
 *
 * To replay caller-owned CSV after this setup, reconnect once to reset the
 * transport timestamp, notifyRaw(firstRow), and manually resume the shell.
 * Then advance the shared clock by each row's receipt delta, notifyRaw(row),
 * and call r.frame(). Keep long gaps: they must trigger real stale/timing pauses.
 * dispose releases only the fake GATT transport and never accesses a device.
 */
function createBleGameRuntime(game, options = {}) {
  const REST_RAW = options.baseline0 ?? 4095, SQUEEZE_RAW = options.baseline100 ?? 300;
  const clock = clockBoundary(), ble = bleBoundary(), storage = new Map();
  let lastCsv = '';
  const r = runtime(game, { difficulty: 'easy', ...options.settings }, {
    clock, random: () => 0.5,
    createSensor: ({ data }) => createSensorService({
      navigator: ble.navigator, dataService: data, now: clock.now,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      wallNow: () => new Date(options.wallTime || WALL_TIME), getUserId: () => 'synthetic-user', isSecureContext: true,
      storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    }),
  });
  const emit = (fsr, flex = 1024) => {
    lastCsv = `${clock.now()},${flex},${fsr}`;
    ble.send(lastCsv);
  };
  // One notification and one animation frame per 50ms. This deliberately models
  // a supported low-FPS browser without accelerating the 20Hz firmware stream.
  const tick = async (fsr, flex = 1024) => { await clock.advance(50); emit(fsr, flex); r.frame(); };
  const feed = async (ms, fsr, flex = 1024) => {
    assert.equal(ms % 50, 0, 'Synthetic intervals must be exact 20Hz steps');
    for (let elapsed = 0; elapsed < ms; elapsed += 50) await tick(fsr, typeof flex === 'function' ? flex(elapsed) : flex);
  };
  const invalidTick = async csv => { await clock.advance(50); ble.send(csv); r.frame(); };
  const capture = async fsr => {
    const pending = r.sensor.captureBaseline();
    await feed(1000, fsr);
    return pending;
  };
  const calibrate = async () => {
    const rest = await capture(REST_RAW), squeeze = await capture(SQUEEZE_RAW);
    assert.ok(rest.sampleCount >= 15 && squeeze.sampleCount >= 15);
    const calibration = r.sensor.saveBleCalibration(rest, squeeze);
    assert.equal(calibration.baseline0, REST_RAW);
    assert.equal(calibration.baseline100, SQUEEZE_RAW);
    // A real reconnect proves the stored calibration is reused and seeds the
    // first fresh sample at exactly zero; no force setter or internals are used.
    await r.sensor.reconnect();
    emit(REST_RAW);
    return calibration;
  };
  const connect = async () => { await r.sensor.connectBle(); emit(REST_RAW); };
  const start = async (practice = false) => {
    r.start(practice);
    await feed(2100, REST_RAW);
    assert.equal(r.run('shell.state.phase'), 'playing');
    assert.equal(r.sensor.getMode(), 'ble');
  };
  const notifyRaw = ({ timestampMs, flexRaw, fsrRaw }) => ble.send(`${timestampMs},${flexRaw},${fsrRaw}`);
  const finish = () => r.run(game === 'crane' ? 'handleTimeUp()' : game === 'glide' ? 'finish()' : 'endGame()');
  const dispose = () => r.sensor.disconnect();
  return { r, sensor:r.sensor, clock, ble, emit, tick, feed, invalidTick, capture, calibrate, connect, start, notifyRaw, finish, dispose, lastCsv: () => lastCsv };
}


module.exports = { createBleGameRuntime, REST_RAW, SQUEEZE_RAW, rawFor };
