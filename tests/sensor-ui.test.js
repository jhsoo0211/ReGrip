const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// The production UI scripts run unchanged; only DOM, clock, and sensor boundaries are mocked.
function runtime(initialMode = 'ble', calibrationPage = false) {
  let now = 0, mode = initialMode, status = 'connected', force = 0, calibration = null, raw = null;
  const timers = [], elements = new Map(), events = new Map();
  const statusListeners = new Set(), rawListeners = new Set(), forceListeners = new Set();
  const calls = { saves: [], loads: 0, suspends: 0, reloads: 0, captures: [] };
  class Element {
    constructor() {
      this.style = {}; this.textContent = ''; this.hidden = false; this.disabled = false; this.value = '';
      this.classes = new Set(); this.selectors = new Map(); this.width = 520; this.height = 116;
      this.classList = { add: (...a) => a.forEach(v => this.classes.add(v)), remove: (...a) => a.forEach(v => this.classes.delete(v)), contains: v => this.classes.has(v), toggle: (v, on) => on ? this.classes.add(v) : this.classes.delete(v) };
      this.lines = []; this.context = { clearRect() {}, beginPath() {}, moveTo: (...p) => this.lines.push(p), lineTo: (...p) => this.lines.push(p), stroke() {} };
    }
    querySelector(selector) { if (!this.selectors.has(selector)) this.selectors.set(selector, new Element()); return this.selectors.get(selector); }
    getContext() { return this.context; }
    removeAttribute() {}
  }
  const document = { getElementById: id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); } };
  const sensor = {
    getMode: () => mode, getStatus: () => status, getForce: () => force, getRawSample: () => raw,
    getCalibration: () => calibration, isReady: () => mode === 'simulation' || status === 'connected' && (mode === 'websocket' || !!calibration),
    onStatusChange: f => statusListeners.add(f), offStatusChange: f => statusListeners.delete(f),
    onRawSample: f => rawListeners.add(f), offRawSample: f => rawListeners.delete(f),
    onForceUpdate: f => forceListeners.add(f), offForceUpdate: f => forceListeners.delete(f),
    restoreConnection: async () => true, loadCalibration: async () => { calls.loads++; },
    connect: () => { mode = 'websocket'; emitStatus('connecting'); },
    connectBle: async () => {}, reconnect: async () => {},
    disconnect: () => emitStatus('disconnected'), useSimulation: () => { mode = 'simulation'; emitStatus('simulation'); },
    suspend: () => { calls.suspends++; emitStatus('disconnected'); },
    captureBaseline: () => new Promise((resolve, reject) => calls.captures.push({ resolve, reject })),
    saveBleCalibration: (rest, squeeze) => { calibration = { baseline0: rest.baseline, baseline100: squeeze.baseline }; return calibration; },
    setCalibration: value => { calibration = value; },
  };
  function emitStatus(value) { status = value; for (const f of [...statusListeners]) f(status); }
  const sandbox = {
    document, SensorService: sensor, DataService: { saveCalibration: async value => calls.saves.push(value) },
    location: { search: '', pathname: '/calibration.html', reload: () => calls.reloads++ }, URLSearchParams, Date, Promise,
    performance: { now: () => now },
    setTimeout: (f, ms) => { const timer = { f, at: now + ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
    addEventListener: (event, callback) => { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(callback); },
    removeEventListener: (event, callback) => events.get(event)?.delete(callback),
    injectFeedbackModal() {}, showToast() {}, console,
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'sensor-ui.js'), 'utf8'), context);
  if (calibrationPage) {
    const html = fs.readFileSync(path.join(root, 'calibration.html'), 'utf8');
    vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1], context);
  } else sandbox.ReGripSensorUI.mount(document.getElementById('panel'));
  const host = document.getElementById(calibrationPage ? 'calibration-sensor-controls' : 'panel');
  return {
    calls, sensor, host, elements, context, document,
    emitStatus, setMode(value) { mode = value; emitStatus('connecting'); },
    emit(event, details = {}) { for (const f of [...(events.get(event) || [])]) f(details); },
    sample(value) { now += 50; force = value; raw = mode === 'websocket' ? { forceRaw: value, fsrRaw: null, flexRaw: null, receivedAt: now } : { fsrRaw: value, flexRaw: 1000, receivedAt: now }; for (const f of [...rawListeners]) f(raw); for (const f of [...forceListeners]) f(force); },
    finishTimer() { const due = timers.filter(t => t.at <= now); for (const timer of due) { timers.splice(timers.indexOf(timer), 1); timer.f(); } },
    capture(n) { return sandbox.captureBaseline(n); },
    element: id => document.getElementById(id),
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('Wi-Fi diagnostics and calibration use forceRaw in percent, before legacy normalization', async () => {
  const r = runtime('websocket', true); await flush();
  let pending = r.capture(1);
  for (let i = 0; i < 20; i++) r.sample(20);
  r.finishTimer(); await pending;
  assert.equal(r.element('step-1').classList.contains('step-done'), true);
  assert.equal(r.host.querySelector('[data-fsr]').textContent, '20');
  assert.equal(r.host.querySelector('[data-fsr-unit]').textContent, '%');
  assert.match(r.element('calibration-raw').textContent, /20 %/);
  assert.ok(r.host.querySelector('canvas').lines.length > 0);
  pending = r.capture(2);
  for (let i = 0; i < 20; i++) r.sample(80);
  r.finishTimer(); await pending;
  assert.equal(r.calls.saves.length, 1);
  assert.equal(r.calls.saves[0].baseline0, 20);
  assert.equal(r.calls.saves[0].baseline100, 80);
});

test('reset while a capture is pending cannot restore the old first baseline', async () => {
  const r = runtime('ble', true); const pending = r.capture(1);
  r.element('reset-calibration').onclick();
  r.calls.captures[0].resolve({ baseline: 500, spread: 0 }); await pending;
  assert.equal(r.element('step-1').classList.contains('step-done'), false);
  assert.equal(r.element('baseline-info').classList.contains('hidden'), true);
  assert.equal(r.element('btn-cap-2').disabled, true);
  assert.equal(r.element('btn-cap-1').disabled, false);
});

test('stale or changed connection invalidates the first baseline before another capture', async () => {
  const r = runtime('ble', true); const pending = r.capture(1);
  r.calls.captures[0].resolve({ baseline: 500, spread: 0 }); await pending;
  assert.equal(r.element('btn-cap-2').disabled, false);
  r.emitStatus('stale'); r.emitStatus('connected');
  assert.equal(r.element('btn-cap-2').disabled, true);
  assert.equal(r.element('step-1').classList.contains('step-done'), false);
});

test('switching from BLE to a legacy Wi-Fi sensor loads its calibration', async () => {
  const r = runtime('ble'); await flush();
  r.host.querySelector('[data-ws-url]').value = 'ws://192.168.4.1:8080';
  await r.host.querySelector('[data-ws-connect]').onclick();
  assert.equal(r.calls.loads, 1);
});

test('BFCache return rebuilds the whole page after pagehide transport and UI cleanup', () => {
  const r = runtime('ble', true);
  r.emit('pageshow', { persisted: false }); assert.equal(r.calls.reloads, 0);
  r.emit('pagehide', { persisted: true }); assert.equal(r.calls.suspends, 1);
  r.emit('pageshow', { persisted: true }); assert.equal(r.calls.reloads, 1);
});
