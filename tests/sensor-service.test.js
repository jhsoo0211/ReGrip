'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSensorService, parseBlePacket } = require('../sensor-service');

const SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
// Sensor PCB protocol v3, as sent by firmware/xiao-glove/regrip_sensor_pcb_5ch.
function glovePacket(timestamp, fingers, { sampleId = timestamp & 0xffff, connectedMask = 0x1f, errorCode = 0 } = {}) {
  const bytes = new Uint8Array(20), view = new DataView(bytes.buffer);
  bytes.set([0x52, 3]); view.setUint16(2, sampleId, true); view.setUint32(4, timestamp, true);
  fingers.forEach((value, i) => view.setUint16(8 + i * 2, value, true));
  view.setUint8(18, connectedMask); view.setUint8(19, errorCode);
  return view;
}
function sendGlove(h, timestamp, fingers, extra) {
  h.device.characteristic.value = glovePacket(timestamp, fingers, extra);
  h.device.characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
}

test('sensor PCB v3 packet preserves every raw channel without inventing pressure', () => {
  const bytes = glovePacket(4294967295, [100, 200, 300, 400, 500], { sampleId: 65535, connectedMask: 0b01001 });
  const offset = new Uint8Array(24); offset.set(new Uint8Array(bytes.buffer), 2);
  assert.deepEqual(parseBlePacket(new DataView(offset.buffer, 2, 20)), {
    sampleId: 65535, timestampMs: 4294967295, fingerRaw: [100, 200, 300, 400, 500], gripRaw: 300,
    connectedMask: 0b01001, errorCode: 0,
  });
  assert.equal(parseBlePacket(glovePacket(1, [0, 0, 4096, 0, 0])), null);
  assert.equal(parseBlePacket(new DataView(bytes.buffer, 0, 19)), null);
  bytes.setUint8(1, 2); assert.equal(parseBlePacket(bytes), null);
  bytes.setUint8(1, 3); bytes.setUint8(0, 0x53); assert.equal(parseBlePacket(bytes), null);
  // The unverified v1 glove format ("RG", 18 bytes) is no longer produced by any firmware here.
  const v1 = new Uint8Array(18); v1.set([0x52, 0x47, 1, 5]);
  assert.equal(parseBlePacket(v1), null);
});

test('app parser matches the hardware-verified monitor parser on the same bytes', async () => {
  const { pathToFileURL } = require('node:url'), path = require('node:path');
  const core = await import(pathToFileURL(path.join(__dirname, '..', 'tools', 'flex-monitor', 'regrip-flex-core.mjs')).href);
  let seed = 7;
  const next = limit => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % limit; };
  const packets = [glovePacket(123456, [1780, 4095, 4095, 1825, 4095], { sampleId: 65535, connectedMask: 0b01001 })];
  for (let n = 0; n < 2000; n++) {
    const view = glovePacket(next(4294967296), Array.from({ length: 5 }, () => next(4200)),
      { sampleId: next(65536), connectedMask: next(256), errorCode: next(4) });
    view.setUint8(1, [2, 3, 3, 3, 4][next(5)]);
    packets.push(view);
  }
  let valid = 0;
  for (const view of packets) {
    const ours = parseBlePacket(view), verified = core.parseBleFlexPacket(view);
    if (!verified) { assert.equal(ours, null); continue; }
    valid++;
    assert.deepEqual(ours, {
      sampleId: verified.sampleId, timestampMs: verified.timestampMs,
      fingerRaw: core.FINGERS.map(({ key }) => verified.raw[key]),
      gripRaw: core.FINGERS.reduce((sum, { key }) => sum + verified.raw[key], 0) / 5,
      connectedMask: verified.connectedMask, errorCode: verified.errorCode,
    });
  }
  assert.ok(valid > 100 && valid < packets.length, 'Both accepted and rejected packets must be compared');
});

test('firmware advertises the UUIDs and v3 packet shape the app parses', () => {
  const fs = require('node:fs'), path = require('node:path');
  const sketch = fs.readFileSync(path.join(__dirname, '..', 'firmware', 'xiao-glove', 'regrip_sensor_pcb_5ch', 'regrip_sensor_pcb_5ch.ino'), 'utf8');
  assert.match(sketch, new RegExp(`BLE_SERVICE_UUID\\[\\] = "${SERVICE}"`, 'i'));
  assert.match(sketch, new RegExp(`BLE_TX_UUID\\[\\] = "${TX}"`, 'i'));
  assert.match(sketch, /advertising->addServiceUUID\(BLE_SERVICE_UUID\)/);
  assert.match(sketch, /uint8_t packet\[20\]/);
  assert.match(sketch, /packet\[0\] = 0x52;/);
  assert.match(sketch, /packet\[1\] = 3;/);
  assert.match(sketch, /FLEX_PINS\[\] = \{D0, D1, D2, D3, D4\}/);
});

test('100Hz sensor PCB stream stays fresh and calibrates from about one second of packets', async () => {
  const h = setup(); await h.service.connectBle();
  let timestamp = 1000;
  sendGlove(h, timestamp, [1780, 4095, 4095, 1825, 4095], { connectedMask: 0b01001 });
  async function stream(fingers, ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      await h.clock.advance(10); timestamp += 10; sendGlove(h, timestamp, fingers, { connectedMask: 0b01001 });
    }
  }
  async function captureAt(fingers) { const pending = h.service.captureBaseline(); await stream(fingers, 1010); return pending; }
  const rest = await captureAt([1780, 4095, 4095, 1825, 4095]);
  const grip = await captureAt([2780, 4095, 4095, 2825, 4095]);
  assert.ok(rest.sampleCount >= 95 && grip.sampleCount >= 95, `${rest.sampleCount}/${grip.sampleCount}`);
  const cal = h.service.saveBleCalibration(rest, grip);
  assert.equal(cal.channel, 'finger_mean');
  assert.equal(h.service.getStatus(), 'connected');
  assert.equal(h.service.getForce(), 100);
  assert.equal(h.service.getRawSample().connectedMask, 0b01001);
  await stream([1780, 4095, 4095, 1825, 4095], 500);
  assert.ok(h.service.getForce() < 0.5);
  h.service.disconnect();
});

test('five-finger BLE input uses measured calibration and records finger_mean provenance', async () => {
  const h = setup(); await h.service.connectBle();
  let timestamp = 1;
  sendGlove(h, timestamp, [400, 500, 600, 700, 800]);
  assert.equal(h.service.isReady(), false);
  async function captureFingers(fingers) {
    const pending = h.service.captureBaseline();
    for (let i = 0; i < 20; i++) { await h.clock.advance(45); timestamp += 45; sendGlove(h, timestamp, fingers); }
    await h.clock.advance(100); return pending;
  }
  const rest = await captureFingers([400, 500, 600, 700, 800]);
  const grip = await captureFingers([1400, 1500, 1600, 1700, 1800]);
  h.service.saveBleCalibration(rest, grip);
  assert.equal(h.service.getCalibration().channel, 'finger_mean');
  assert.equal(h.service.getCalibration().baseline0, 600);
  assert.equal(h.service.getForce(), 100);
  assert.equal(h.service.isReady(), true);
  assert.equal(h.service.getRawSample().fsrRaw, undefined);
  assert.equal(h.service.getSessionContext().calibrationSnapshot.channel, 'finger_mean');
  // A different wire format must not inherit a five-finger calibration.
  h.device.send(`${timestamp + 100},100,1600`);
  assert.equal(h.service.isReady(), false);
  h.service.disconnect();
});
function makeClock() {
  let time = 1, nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      time = end; await flush();
    },
  };
}
function makeDevice(id = 'board-A') {
  const device = new EventTarget(); device.id = id; device.name = 'ReGrip-Sensor';
  const characteristic = new EventTarget();
  characteristic.startNotifications = async () => characteristic;
  characteristic.stopNotifications = async () => characteristic;
  device.characteristic = characteristic;
  device.failures = 0;
  device.gatt = {
    connected: false,
    async connect() {
      if (device.failures-- > 0) throw new Error('out of range');
      this.connected = true; return this;
    },
    async getPrimaryService(uuid) {
      assert.equal(uuid, SERVICE);
      return { async getCharacteristic(tx) { assert.equal(tx, TX); return characteristic; } };
    },
    disconnect() {
      if (!this.connected) return;
      this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  device.send = text => {
    characteristic.value = new DataView(new TextEncoder().encode(text).buffer);
    characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  return device;
}
function setup(options = {}) {
  const clock = makeClock(), device = makeDevice(), map = options.map || new Map();
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  let user = 'user-1', chooserCalls = 0;
  const bluetooth = {
    // Same chooser filter as the hardware-verified monitor; covers ReGrip-5CH and the FSR board.
    requestDevice(args) { chooserCalls++; assert.deepEqual(args, { filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] }); return Promise.resolve(device); },
    getDevices: async () => [device],
  };
  const service = createSensorService({
    navigator: { bluetooth }, storage, now: clock.now, wallNow: () => new Date('2026-09-05T00:00:00Z'),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, getUserId: () => user, isSecureContext: true,
    ...options,
  });
  return { service, clock, device, storage, map, bluetooth, chooserCalls: () => chooserCalls, setUser: id => { user = id; } };
}
async function connect(h) { await h.service.connectBle(); h.device.send('1,100,200'); }
async function capture(h, value, timestamp = 100) {
  const pending = h.service.captureBaseline();
  for (let i = 0; i < 20; i++) { await h.clock.advance(45); h.device.send(`${timestamp + i * 45},100,${value}`); }
  await h.clock.advance(100); return pending;
}

test('CSV parser retains uint32 timestamps and rejects empty, fractional, non-ASCII, and out-of-range fields', () => {
  assert.deepEqual(parseBlePacket('4294967295,4095,4095'), { timestampMs: 4294967295, flexRaw: 4095, fsrRaw: 4095 });
  assert.deepEqual(parseBlePacket(' 0,0,0\n'), { timestampMs: 0, flexRaw: 0, fsrRaw: 0 });
  for (const invalid of ['', '1,,2', '1,2,', '-1,2,3', '1,2.5,3', '1,0x10,3', '1,4096,3', '4294967296,2,3', '1,2,3,4', '１,2,3', '1, 2,3']) {
    assert.equal(parseBlePacket(invalid), null, invalid);
  }
});

test('BLE chooser is invoked in the original click call and connection waits for a valid notification', async () => {
  const h = setup(), pending = h.service.connectBle();
  assert.equal(h.chooserCalls(), 1);
  await pending;
  assert.equal(h.service.getStatus(), 'connecting');
  h.device.send('invalid'); assert.equal(h.service.getStatus(), 'connecting');
  h.device.send('1,120,2048');
  assert.equal(h.service.getStatus(), 'connected');
  assert.deepEqual(h.service.getRawSample(), { timestampMs: 1, flexRaw: 120, fsrRaw: 2048, receivedAt: 1 });
  assert.equal(h.service.isReady(), false);
  h.service.disconnect();
});

test('FSR controls force with 80ms filtering while flex remains diagnostic', async () => {
  const h = setup(); await h.service.connectBle(); h.device.send('1,4095,0');
  assert.equal(h.service.getForce(), 0);
  await h.clock.advance(80); h.device.send('81,0,4095');
  assert.ok(Math.abs(h.service.getForce() - 63.212055882855765) < 1e-9);
  assert.equal(h.service.getRawSample().flexRaw, 0);
  h.service.disconnect();
});

test('malformed and duplicate notifications cannot keep frozen input fresh', async () => {
  const h = setup(); await connect(h);
  await h.clock.advance(300); h.device.send('1,100,200'); h.device.send('999,,200');
  await h.clock.advance(200);
  assert.equal(h.service.getStatus(), 'stale'); assert.equal(h.service.isReady(), false);
  h.device.send('501,100,250'); assert.equal(h.service.getStatus(), 'connected');
  h.service.disconnect();
});

for (const timestamp of [99, 100]) {
  test(`rejected glove timestamp ${timestamp} cannot cancel an FSR capture or reset filtering`, async () => {
    const h = setup(); await h.service.connectBle(); h.device.send('100,0,0');
    const pending = capture(h, 4095, 180);
    sendGlove(h, timestamp, [1000, 1000, 1000, 1000, 1000]);
    assert.equal(h.service.getRawSample().timestampMs, 100);
    const rest = await pending;
    assert.equal(rest.channel, 'fsr'); assert.equal(rest.sampleCount, 20);
    assert.equal(rest.baseline, 4095);
    h.service.disconnect();

    const filtered = setup(); await filtered.service.connectBle(); filtered.device.send('100,0,0');
    sendGlove(filtered, timestamp, [1000, 1000, 1000, 1000, 1000]);
    await filtered.clock.advance(80); filtered.device.send('180,0,4095');
    assert.ok(Math.abs(filtered.service.getForce() - 63.212055882855765) < 1e-9);
    filtered.service.disconnect();
  });
}

test('an accepted sensor-channel change cancels capture and cannot reuse another channel calibration', async () => {
  const h = setup(); await connect(h);
  const rest = await capture(h, 500), squeeze = await capture(h, 2500, 2000);
  h.service.saveBleCalibration(rest, squeeze);
  const pending = h.service.captureBaseline();
  const rejected = assert.rejects(pending, /입력 종류/);
  sendGlove(h, 3000, [500, 500, 500, 500, 500]);
  await rejected;
  assert.equal(h.service.getCalibration(), null);
  assert.equal(h.service.isReady(), false);
  assert.throws(() => h.service.saveBleCalibration(rest, squeeze), /입력 종류/);
  const read = h.service.getRawSample(); read.fingerRaw[0] = 4095;
  assert.equal(h.service.getRawSample().fingerRaw[0], 500);
  h.service.disconnect();
});

test('uint32 timestamp rollover is accepted while backwards frames are rejected', async () => {
  const h = setup(); await h.service.connectBle(); h.device.send('4294967280,0,100');
  await h.clock.advance(50); h.device.send('34,0,200');
  assert.equal(h.service.getRawSample().timestampMs, 34);
  h.device.send('20,0,300'); assert.equal(h.service.getRawSample().fsrRaw, 200);
  h.service.disconnect();
});

test('disconnection freezes real mode until explicit simulation selection', async () => {
  const h = setup(); await connect(h); h.service.disconnect();
  assert.equal(h.service.getMode(), 'ble'); assert.equal(h.service.getStatus(), 'disconnected');
  h.service.setSimulatedForce(100); assert.notEqual(h.service.getForce(), 100);
  h.service.useSimulation(); h.service.setSimulatedForce(72);
  assert.equal(h.service.getForce(), 72); assert.equal(h.service.isReady(), true);
  assert.deepEqual(h.service.getSessionContext(), { inputSource: 'simulation', calibrationSnapshot: null });
});

test('BLE reconnect continues after a failed retry and removes old notification subscriptions', async () => {
  const h = setup(); await connect(h); let count = 0;
  h.service.onRawSample(() => count++);
  h.device.failures = 1; h.device.gatt.disconnect();
  await h.clock.advance(1000); assert.equal(h.device.gatt.connected, false);
  await h.clock.advance(2000); assert.equal(h.device.gatt.connected, true);
  h.device.send('4000,100,200'); assert.equal(count, 1);
  h.service.disconnect();
});

test('restoration uses the exact saved device identity and never opens a chooser automatically', async () => {
  const h = setup(); await connect(h);
  const twin = makeDevice('same-name-other-board');
  const restored = setup({ map: h.map, navigator: { bluetooth: { getDevices: async () => [twin, h.device], requestDevice() { throw new Error('unexpected chooser'); } } } });
  assert.equal(await restored.service.restoreConnection(), true);
  h.device.send('2,100,300'); assert.equal(restored.service.getRawSample().fsrRaw, 300);
  assert.equal(twin.gatt.connected, false);
  restored.service.disconnect(); h.service.disconnect();
});

test('missing getDevices and cancelled chooser are recoverable without entering simulation', async () => {
  const h = setup({ navigator: { bluetooth: { requestDevice: () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'NotFoundError' })) } } });
  assert.equal(await h.service.restoreConnection(), false);
  await assert.rejects(h.service.connectBle(), /cancelled/);
  assert.equal(h.service.getStatus(), 'disconnected'); assert.equal(h.service.getMode(), 'ble');
});

test('explicit reconnect can restore a remembered device after automatic restoration was disabled', async () => {
  const h = setup(); await connect(h); h.service.disconnect();
  const next = setup({ map: h.map, navigator: { bluetooth: { getDevices: async () => [h.device], requestDevice() { throw new Error('unexpected chooser'); } } } });
  assert.equal(await next.service.restoreConnection(), false);
  assert.equal(await next.service.reconnect(), true);
  h.device.send('50,100,250'); assert.equal(next.service.getStatus(), 'connected');
  next.service.disconnect();
});

test('capture starts after the button action and saves decreasing raw calibration in its exact versioned shape', async () => {
  const h = setup(); await connect(h);
  const rest = await capture(h, 3000), squeeze = await capture(h, 1000, 2000);
  const cal = h.service.saveBleCalibration(rest, squeeze);
  assert.deepEqual(cal, { version: 2, source: 'ble', unit: 'adc_12bit', channel: 'fsr', baseline0: 3000, baseline100: 1000, capturedAt: '2026-09-05T00:00:00.000Z' });
  assert.equal(rest.sampleCount, 20); assert.equal(rest.baseline, 3000);
  assert.equal(h.service.isReady(), true);
  assert.deepEqual(h.service.getSessionContext(), { inputSource: 'ble', calibrationSnapshot: cal });
  assert.equal(h.map.has('regrip_calibration'), false);
  h.service.disconnect();
});

test('calibration rejects too few, interrupted, too narrow, or noisy captures', async () => {
  const h = setup(); await connect(h);
  const failed = h.service.captureBaseline(); const result = assert.rejects(failed, /샘플|연결|수신/);
  await h.clock.advance(1000); await result;
  h.device.send('1100,100,200');
  const rest = await capture(h, 1000, 1200), squeeze = await capture(h, 1030, 2300);
  assert.throws(() => h.service.saveBleCalibration(rest, squeeze), /64|범위/);
  assert.throws(() => h.service.saveBleCalibration(rest, { ...squeeze, baseline: 2000, spread: 250 }), /흔들|안정/);
  h.service.disconnect();
});

test('BLE calibration is scoped to current user and device and ignores legacy stored percentages', async () => {
  const h = setup(); h.map.set('regrip_calibration', JSON.stringify({ baseline0: 10, baseline100: 90 }));
  await connect(h); assert.equal(h.service.getCalibration(), null);
  const rest = await capture(h, 500), squeeze = await capture(h, 2500, 2000); h.service.saveBleCalibration(rest, squeeze);
  h.setUser('user-2'); assert.equal(h.service.getCalibration(), null); assert.equal(h.service.isReady(), false);
  assert.throws(() => h.service.saveBleCalibration(rest, squeeze), /사용자|기기/);
  h.service.disconnect();
});

test('legacy websocket normalization remains available but invalid calibration cannot poison the force', async () => {
  const sockets = [];
  class Socket { constructor() { sockets.push(this); } close() {} }
  const h = setup({ WebSocket: Socket });
  h.service.setCalibration({ baseline0: 20, baseline100: 80 }); h.service.connect('ws://sensor');
  sockets[0].onopen(); sockets[0].onmessage({ data: '{"force":50,"timestamp":1}' });
  assert.equal(h.service.getForce(), 50); assert.equal(h.service.isReady(), true);
  assert.throws(() => h.service.setCalibration({ baseline0: NaN, baseline100: 80 }), /보정|범위/);
  assert.equal(h.service.getForce(), 50);
  h.service.disconnect();
});

test('obsolete websocket close events cannot invalidate a newer connection', () => {
  const sockets = [];
  class Socket { constructor() { sockets.push(this); } close() {} }
  const h = setup({ WebSocket: Socket });
  h.service.connect('ws://old'); const oldClose = sockets[0].onclose;
  h.service.connect('ws://new'); sockets[1].onopen(); sockets[1].onmessage({ data: '{"force":70,"timestamp":1}' });
  oldClose(); assert.equal(h.service.getStatus(), 'connected'); assert.equal(h.service.getForce(), 70);
  h.service.disconnect();
});

test('a missing legacy calibration clears the previous normalization for the same owner', async () => {
  const sockets = []; let calibration = { baseline0: 20, baseline100: 80 };
  class Socket { constructor() { sockets.push(this); } close() {} }
  const h = setup({ WebSocket: Socket, dataService: { _storageScope: () => 'local', getCalibration: async () => calibration } });
  h.service.connect('ws://sensor'); await h.service.loadCalibration();
  sockets[0].onmessage({ data: '{"force":20,"timestamp":1}' }); assert.equal(h.service.getForce(), 0);
  calibration = null; await h.service.loadCalibration();
  assert.equal(h.service.getCalibration(), null); assert.equal(h.service.getForce(), 20);
  h.service.disconnect();
});

test('owner changes discard in-flight legacy data and freeze input until the document is rebuilt', async () => {
  const sockets = []; let scope = 'rest:server-a:user-1', finish;
  class Socket { constructor() { sockets.push(this); } close() {} }
  const h = setup({ WebSocket: Socket, dataService: { _storageScope: () => scope, getCalibration: () => new Promise(resolve => { finish = resolve; }) } });
  h.service.connect('ws://sensor'); h.service.setCalibration({ baseline0: 20, baseline100: 80 });
  const oldMessage = sockets[0].onmessage;
  oldMessage({ data: '{"force":80,"timestamp":1}' }); assert.equal(h.service.isReady(), true);
  const pending = h.service.loadCalibration(); scope = 'rest:server-b:user-1';
  assert.equal(h.service.isReady(), false); assert.equal(h.service.getForce(), 0);
  assert.equal(h.service.getCalibration(), null); assert.equal(h.service.getRawSample(), null);
  finish({ baseline0: 10, baseline100: 90 }); await pending;
  oldMessage({ data: '{"force":100,"timestamp":2}' });
  assert.equal(h.service.getCalibration(), null); assert.equal(h.service.getForce(), 0);
  await assert.rejects(h.service.reconnect(), /새로고침/);
  h.service.useSimulation(); assert.equal(h.service.isReady(), false);
});

test('a stale load cannot overwrite calibration explicitly saved while its request was pending', async () => {
  let finish;
  const h = setup({ WebSocket: class { close() {} }, dataService: { getCalibration: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = h.service.loadCalibration(); h.service.setCalibration({ baseline0: 30, baseline100: 70 });
  finish({ baseline0: 10, baseline100: 90 }); await pending;
  h.service.connect('ws://sensor');
  assert.deepEqual(h.service.getCalibration(), { baseline0: 30, baseline100: 70 });
  h.service.disconnect();
});

test('BLE calibration separates identical user and device IDs on different API servers', async () => {
  const first = setup({ dataService: { _storageScope: () => 'rest:server-a:user-1' } }); await connect(first);
  const rest = await capture(first, 500), squeeze = await capture(first, 2500, 2000);
  first.service.saveBleCalibration(rest, squeeze); first.service.disconnect();
  const second = setup({ map: first.map, dataService: { _storageScope: () => 'rest:server-b:user-1' } }); await connect(second);
  assert.equal(second.service.getCalibration(), null); assert.equal(second.service.isReady(), false);
  second.service.disconnect();
});

test('standalone diagnostics and app use the same API scope for an anonymous browser', async () => {
  const base = 'http://localhost:8000', map = new Map([['regrip_api_base', base]]);
  const first = setup({ map, getUserId: () => null }); await connect(first);
  const rest = await capture(first, 500), squeeze = await capture(first, 2500, 2000);
  const expected = first.service.saveBleCalibration(rest, squeeze); first.service.disconnect();
  const second = setup({ map, getUserId: () => null, dataService: { _storageScope: () => `rest:${encodeURIComponent(base)}:%40unowned` } }); await connect(second);
  assert.deepEqual(second.service.getCalibration(), expected);
  second.service.disconnect();
});

test('browser script order initializes the owner only after shared REST bootstrap', () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const base = 'http://localhost:8000';
  const map = new Map([['regrip_api_base', base], ['regrip_user', JSON.stringify({ id: 'user-1' })]]);
  const sandbox = {
    localStorage: { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) },
    navigator: {}, performance: { now: () => 0 }, setTimeout, clearTimeout,
    addEventListener() {}, removeEventListener() {}, console,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['sensor-service.js', 'sensor-ui.js', 'shared.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  assert.equal(vm.runInContext('DataService.isRest()', context), true);
  assert.equal(vm.runInContext('SensorService === globalThis.SensorService', context), true);
  assert.equal(vm.runInContext('SensorService.isReady()', context), true);
  vm.runInContext('SensorService.setSimulatedForce(42)', context);
  assert.equal(vm.runInContext('SensorService.getForce()', context), 42);
  map.set('regrip_user', JSON.stringify({ id: 'user-2' }));
  assert.equal(vm.runInContext('SensorService.isReady()', context), false);
  assert.equal(vm.runInContext('SensorService.getForce()', context), 0);
});
