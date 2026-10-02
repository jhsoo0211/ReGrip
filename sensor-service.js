(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ReGripSensor = api; root.SensorService = api.createSensorService(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  const CONNECTION_KEY = 'regrip_sensor_connection_v2';
  const CAL_PREFIX = 'regrip_sensor_calibration_v2:';
  const FRESH_MS = 500, FILTER_MS = 80, CAPTURE_MS = 1000, MIN_SPAN = 64;
  // The sensor PCB firmware treats a pulled-up input (>= 4090) as an unconnected channel.
  const UNPLUGGED_ADC = 4090;
  const SENSOR_MODES = ['ble', 'usb'];
  const FINGERS = Object.freeze([
    { key: 'thumb', label: '엄지', pin: 'D0' }, { key: 'index', label: '검지', pin: 'D1' },
    { key: 'middle', label: '중지', pin: 'D2' }, { key: 'ring', label: '약지', pin: 'D3' },
    { key: 'little', label: '소지', pin: 'D4' },
  ].map(Object.freeze));
  const clamp = value => Math.max(0, Math.min(100, value));
  const clone = value => value ? { ...value, ...(value.fingerRaw ? { fingerRaw: [...value.fingerRaw] } : {}) } : null;
  const copy = value => value ? JSON.parse(JSON.stringify(value)) : null;
  const inputChannel = sample => sample?.fingerRaw ? 'finger_flex' : 'fsr';
  const inputValue = sample => sample?.fingerRaw ? sample.gripRaw : sample?.fsrRaw;
  const isSensorMode = mode => SENSOR_MODES.includes(mode);
  const pinConnected = (sample, i) => (sample.connectedMask >> i & 1) === 1;
  const cancelled = () => new Error('연결 요청이 취소되었습니다.');

  function fingerSample(sampleId, timestampMs, fingerRaw, connectedMask, errorCode) {
    return { sampleId, timestampMs, fingerRaw, gripRaw: fingerRaw.reduce((sum, value) => sum + value, 0) / 5, connectedMask, errorCode };
  }

  function parseBlePacket(payload) {
    if (ArrayBuffer.isView(payload) || payload instanceof ArrayBuffer) {
      const view = ArrayBuffer.isView(payload)
        ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength) : new DataView(payload);
      // Sensor PCB protocol v3 (hardware-verified, tools/flex-monitor): 'R', version 3,
      // uint16 sample id, uint32 ms, five uint16 ADC values, connected-channel mask, error code.
      if (view.byteLength === 20 && view.getUint8(0) === 0x52 && view.getUint8(1) === 3) {
        const fingerRaw = Array.from({ length: 5 }, (_, i) => view.getUint16(8 + i * 2, true));
        if (fingerRaw.some(value => value > 4095)) return null;
        return fingerSample(view.getUint16(2, true), view.getUint32(4, true), fingerRaw, view.getUint8(18), view.getUint8(19));
      }
    }
    let text;
    try {
      text = typeof payload === 'string' ? payload : new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch { return null; }
    const match = /^(\d{1,10}),(\d{1,4}),(\d{1,4})$/.exec(text.trim());
    if (!match) return null;
    const [timestampMs, flexRaw, fsrRaw] = match.slice(1).map(Number);
    if (timestampMs > 4294967295 || flexRaw > 4095 || fsrRaw > 4095) return null;
    return { timestampMs, flexRaw, fsrRaw };
  }

  // USB CSV from the same firmware: sample_id,timestamp_ms,thumb..little. Header and '#' lines are not samples.
  function parseSerialLine(line) {
    const match = /^(\d{1,10}),(\d{1,10}),(\d{1,4}),(\d{1,4}),(\d{1,4}),(\d{1,4}),(\d{1,4})$/.exec(String(line ?? '').trim());
    if (!match) return null;
    const [sampleId, timestampMs, ...fingerRaw] = match.slice(1).map(Number);
    if (sampleId > 4294967295 || timestampMs > 4294967295 || fingerRaw.some(value => value > 4095)) return null;
    // USB has no mask field; derive it exactly as the firmware does for BLE.
    const connectedMask = fingerRaw.reduce((mask, value, i) => value < UNPLUGGED_ADC ? mask | 1 << i : mask, 0);
    return fingerSample(sampleId, timestampMs, fingerRaw, connectedMask, 0);
  }

  const adc = value => Number.isFinite(value) && value >= 0 && value <= 4095;
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  // Version 2: one ADC channel (FSR board over BLE).
  function validBleCalibration(cal) {
    return cal && cal.version === 2 && cal.source === 'ble' && cal.unit === 'adc_12bit' && ['fsr', 'finger_mean'].includes(cal.channel)
      && adc(cal.baseline0) && adc(cal.baseline100) && Math.abs(cal.baseline100 - cal.baseline0) >= MIN_SPAN && validDate(cal.capturedAt);
  }
  // Version 3: open/closed per finger of the sensor PCB; null marks a finger excluded at capture.
  function validFingerCalibration(cal) {
    return cal && cal.version === 3 && isSensorMode(cal.source) && cal.unit === 'adc_12bit' && cal.channel === 'finger_flex'
      && Array.isArray(cal.fingers) && cal.fingers.length === 5
      && cal.fingers.every(f => f === null || (f && adc(f.open) && adc(f.closed) && Math.abs(f.closed - f.open) >= MIN_SPAN && typeof f.use === 'boolean'))
      && cal.fingers.some(f => f?.use) && validDate(cal.capturedAt);
  }

  function describeFingers(sample, cal) {
    if (!Array.isArray(sample?.fingerRaw)) return null;
    const fits = cal?.version === 3 ? cal.fingers : [];
    return FINGERS.map((finger, i) => {
      const fit = fits[i] || null, connected = pinConnected(sample, i), raw = sample.fingerRaw[i];
      return { ...finger, raw, connected, calibrated: !!fit, use: !!fit?.use,
        percent: fit && connected ? clamp((raw - fit.open) / (fit.closed - fit.open) * 100) : null };
    });
  }
  // Game input is the mean bend of the selected fingers; null while a selected finger is unplugged.
  function fingerInput(sample, cal) {
    const used = describeFingers(sample, cal).filter(f => f.use);
    if (!used.length || used.some(f => !f.connected)) return null;
    return used.reduce((sum, f) => sum + f.percent, 0) / used.length;
  }
  function assessFingerCalibration(rest, squeeze) {
    return FINGERS.map((finger, i) => {
      const open = rest?.fingers?.[i], closed = squeeze?.fingers?.[i];
      if (!open?.connected || !closed?.connected) return { ...finger, status: 'unplugged' };
      const span = Math.abs(closed.baseline - open.baseline);
      if (span < MIN_SPAN) return { ...finger, status: 'narrow', span };
      if (open.spread > span * 0.2 || closed.spread > span * 0.2) return { ...finger, status: 'unstable', span };
      return { ...finger, status: 'ok', span, open: open.baseline, closed: closed.baseline };
    });
  }

  function createSensorService(options = {}) {
    const nav = options.navigator || root.navigator || {};
    const now = options.now || (() => root.performance ? root.performance.now() : Date.now());
    const wallNow = options.wallNow || (() => new Date());
    const later = options.setTimeout || root.setTimeout.bind(root);
    const cancel = options.clearTimeout || root.clearTimeout.bind(root);
    let storage = options.storage;
    if (!storage) { try { storage = root.localStorage; } catch {} }
    if (!storage) {
      const memory = new Map();
      storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };
    }
    const read = key => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
    const write = (key, value) => { try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
    const getAuthUserId = () => options.getUserId ? options.getUserId() : read('regrip_user')?.id;
    const getUserId = () => String(getAuthUserId() || 'anonymous');
    function getDataService() {
      if (options.dataService) return options.dataService;
      try { return typeof DataService !== 'undefined' ? DataService : root.DataService; } catch { return null; }
    }
    function getDataScope() {
      const dataService = getDataService();
      if (typeof dataService?._storageScope === 'function') return dataService._storageScope();
      // The standalone BLE diagnostic does not load shared.js, but shares this browser's owner.
      let base = '';
      try { base = String(storage.getItem('regrip_api_base') || '').replace(/\/+$/, ''); } catch {}
      return base ? `rest:${encodeURIComponent(base)}:${encodeURIComponent(getAuthUserId() || '@unowned')}` : 'local';
    }
    const getUserKey = () => JSON.stringify([getDataScope(), getUserId()]);
    const ownerError = () => new Error('사용자 계정 또는 서버가 바뀌었습니다. 페이지를 새로고침한 뒤 다시 연결해 주세요.');
    const secure = () => options.isSecureContext ?? root.isSecureContext ?? false;
    const saved = read(CONNECTION_KEY);
    let mode = ['ble', 'usb', 'websocket'].includes(saved?.mode) ? saved.mode : 'simulation';
    let status = mode === 'simulation' ? 'simulation' : 'disconnected';
    let force = 0, raw = null, filteredAt = null, lastTimestamp = null, lastReceivedAt = null, inputBlocked = false, arrivals = [];
    let device = null, characteristic = null, ws = null, wsUrl = saved?.wsUrl || null, serial = null, serialClosed = Promise.resolve();
    let packetListener = null, disconnectListener = null;
    let generation = 0, attemptId = 0, retryCount = 0, retryTimer = null, staleTimer = null, connectTimer = null;
    let autoReconnect = saved?.autoReconnect !== false;
    let legacyCalibration = null, cachedCalKey = null, sensorCalibration = null, captureTask = null;
    let documentOwner = null, ownerBlocked = false, calibrationRequest = 0;
    const forceListeners = new Set(), rawListeners = new Set(), statusListeners = new Set();

    function emit(list, value) { for (const cb of list) { try { cb(value); } catch {} } }
    function setStatus(next) { if (next !== status) { status = next; emit(statusListeners, status); } }
    function resetTiming() { filteredAt = null; lastTimestamp = null; lastReceivedAt = null; inputBlocked = false; arrivals = []; }
    function resetReceive() { raw = null; resetTiming(); }
    function ensureOwner() {
      if (ownerBlocked) return false;
      const currentOwner = getUserKey();
      if (documentOwner === null) documentOwner = currentOwner;
      if (documentOwner === currentOwner) return true;
      // A cached page must never finish an earlier owner's game or reuse their normalization.
      ownerBlocked = true; generation++; attemptId++; calibrationRequest++;
      clearTimer('retry'); abortCapture(ownerError().message); releaseTransport();
      force = 0; resetReceive();
      legacyCalibration = null; cachedCalKey = null; sensorCalibration = null;
      setStatus('disconnected'); emit(forceListeners, force);
      return false;
    }
    function isFresh() { return lastReceivedAt !== null && now() - lastReceivedAt < FRESH_MS && status === 'connected'; }
    function calibrationKey() { return device ? CAL_PREFIX + encodeURIComponent(getUserKey()) + ':' + encodeURIComponent(device.id) : null; }
    function currentCalibration() {
      const key = calibrationKey();
      if (key !== cachedCalKey) {
        cachedCalKey = key;
        const stored = key ? read(key) : null;
        sensorCalibration = validFingerCalibration(stored) ? (stored.source === mode ? stored : null)
          : validBleCalibration(stored) && mode === 'ble' ? stored : null;
      }
      return raw && sensorCalibration?.channel !== inputChannel(raw) ? null : copy(sensorCalibration);
    }
    function getCalibration() { return ensureOwner() ? (isSensorMode(mode) ? currentCalibration() : mode === 'websocket' ? copy(legacyCalibration) : null) : null; }
    function abortCapture(message) { if (captureTask) captureTask.fail(new Error(message)); }
    function clearTimer(name) {
      if (name === 'retry') { if (retryTimer !== null) cancel(retryTimer); retryTimer = null; }
      if (name === 'stale') { if (staleTimer !== null) cancel(staleTimer); staleTimer = null; }
      if (name === 'connect') { if (connectTimer !== null) cancel(connectTimer); connectTimer = null; }
    }
    function remember() {
      write(CONNECTION_KEY, { mode, deviceId: device?.id || saved?.deviceId || null, wsUrl, autoReconnect });
    }
    const closePort = link => Promise.resolve().then(() => link.port.close()).catch(() => {}).then(() => link.closed());
    function stopSerial(link) {
      link.stopped = true;
      serialClosed = new Promise(resolve => { link.closed = resolve; });
      // The read loop closes the port once it has released its reader lock.
      if (link.reader) link.reader.cancel().catch(() => {});
      else closePort(link);
    }
    function releaseTransport() {
      clearTimer('stale'); clearTimer('connect');
      if (characteristic && packetListener) characteristic.removeEventListener('characteristicvaluechanged', packetListener);
      if (device && disconnectListener) device.removeEventListener('gattserverdisconnected', disconnectListener);
      characteristic = null; packetListener = null; disconnectListener = null;
      if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch {} ws = null; }
      if (serial) { const link = serial; serial = null; stopSerial(link); }
      // disconnect() also cancels an in-flight GATT connection in supporting browsers.
      if (device?.gatt) { try { device.gatt.disconnect(); } catch {} }
    }
    function begin(nextMode) {
      generation++; attemptId++; clearTimer('retry'); retryCount = 0;
      abortCapture('연결이 바뀌어 보정을 중단했습니다. 다시 측정하세요.');
      releaseTransport(); mode = nextMode;
      resetReceive();
      cachedCalKey = null; sensorCalibration = null;
      setStatus(nextMode === 'simulation' ? 'simulation' : 'connecting');
      return generation;
    }
    function normalizeLegacy(value) {
      return legacyCalibration ? clamp((value - legacyCalibration.baseline0) / (legacyCalibration.baseline100 - legacyCalibration.baseline0) * 100) : clamp(value);
    }
    function sensorTarget(sample) {
      const cal = currentCalibration();
      if (sample.fingerRaw) return cal ? fingerInput(sample, cal) : clamp(sample.gripRaw / 4095 * 100);
      return cal ? clamp((sample.fsrRaw - cal.baseline0) / (cal.baseline100 - cal.baseline0) * 100) : clamp(sample.fsrRaw / 4095 * 100);
    }
    function accept(sample, legacyInput) {
      if (!ensureOwner()) return;
      if (lastTimestamp !== null && sample.timestampMs !== null) {
        const delta = (sample.timestampMs - lastTimestamp) >>> 0;
        if (delta === 0 || delta > 2147483647) return;
      }
      if (raw && inputChannel(raw) !== inputChannel(sample)) {
        abortCapture('센서 입력 종류가 바뀌었습니다. 다시 보정하세요.');
        filteredAt = null;
      }
      const receivedAt = now(), wasFresh = isFresh(), wasBlocked = inputBlocked;
      lastTimestamp = sample.timestampMs;
      lastReceivedAt = receivedAt;
      raw = Object.freeze({ ...sample, receivedAt });
      arrivals.push(receivedAt);
      while (receivedAt - arrivals[0] > 1000) arrivals.shift();
      const target = mode === 'websocket' ? normalizeLegacy(legacyInput) : sensorTarget(raw);
      // A selected finger without signal blocks input; the game pauses instead of guessing.
      inputBlocked = target === null;
      if (inputBlocked) filteredAt = null;
      else {
        force = filteredAt === null || !wasFresh ? target : force + (target - force) * (1 - Math.exp(-(receivedAt - filteredAt) / FILTER_MS));
        filteredAt = receivedAt;
      }
      clearTimer('connect'); clearTimer('stale'); retryCount = 0;
      setStatus('connected');
      if (wasBlocked !== inputBlocked) emit(statusListeners, status);
      staleTimer = later(() => {
        staleTimer = null;
        if (status === 'connected') {
          setStatus('stale'); abortCapture('센서 수신이 끊겨 보정을 중단했습니다. 다시 측정하세요.');
        }
      }, FRESH_MS);
      emit(rawListeners, clone(raw)); emit(forceListeners, force);
    }
    function scheduleRetry(expectedGeneration) {
      if (!autoReconnect || generation !== expectedGeneration || retryTimer !== null || retryCount >= 4) return;
      const delay = 1000 * Math.pow(2, retryCount++);
      retryTimer = later(() => {
        retryTimer = null;
        if (generation !== expectedGeneration || !autoReconnect || !ensureOwner()) return;
        if (mode === 'ble' && device) attachBle(device, expectedGeneration).catch(() => scheduleRetry(expectedGeneration));
        else if (mode === 'usb' && device) reattachUsb(expectedGeneration).catch(() => scheduleRetry(expectedGeneration));
        else if (mode === 'websocket' && wsUrl) attachWebSocket(wsUrl, expectedGeneration);
      }, delay);
    }
    function handleLost(expectedGeneration, expectedAttempt) {
      if (expectedGeneration !== generation || expectedAttempt !== attemptId) return;
      abortCapture('센서 연결이 끊겨 보정을 중단했습니다. 다시 측정하세요.');
      releaseTransport(); lastTimestamp = null; filteredAt = null;
      setStatus('disconnected'); scheduleRetry(expectedGeneration);
    }
    async function attachBle(selected, expectedGeneration) {
      if (expectedGeneration !== generation) throw cancelled();
      const expectedAttempt = ++attemptId;
      releaseTransport(); device = selected; resetTiming();
      setStatus('connecting');
      const current = () => generation === expectedGeneration && attemptId === expectedAttempt;
      const work = async () => {
        const server = await selected.gatt.connect();
        if (!current()) throw cancelled();
        const service = await server.getPrimaryService(SERVICE_UUID);
        const tx = await service.getCharacteristic(TX_UUID);
        if (!current()) throw cancelled();
        characteristic = tx;
        packetListener = event => {
          if (!current()) return;
          const sample = parseBlePacket(event.target.value);
          if (sample) accept(sample);
        };
        disconnectListener = () => handleLost(expectedGeneration, expectedAttempt);
        selected.addEventListener('gattserverdisconnected', disconnectListener);
        tx.addEventListener('characteristicvaluechanged', packetListener);
        await tx.startNotifications();
        if (!current()) throw cancelled();
      };
      let timeout;
      try {
        await Promise.race([work(), new Promise((_, reject) => {
          timeout = later(() => reject(new Error('센서 연결 시간이 초과되었습니다. 전원과 거리를 확인하세요.')), 10000);
        })]);
        if (!current()) throw cancelled();
        cancel(timeout);
        // A GATT connection alone is insufficient: wait for actual valid data.
        if (status !== 'connected') connectTimer = later(() => handleLost(expectedGeneration, expectedAttempt), 3000);
        remember();
        return true;
      } catch (error) {
        cancel(timeout);
        if (current()) { attemptId++; releaseTransport(); setStatus('disconnected'); }
        throw error;
      }
    }
    function usbDevice(port) {
      const info = typeof port?.getInfo === 'function' ? port.getInfo() : {};
      if (!Number.isInteger(info.usbVendorId)) throw new Error('USB 장치를 선택해 주세요. Bluetooth 가상 COM 포트는 사용할 수 없습니다.');
      const hex = value => (value || 0).toString(16).padStart(4, '0');
      return { id: `usb:${hex(info.usbVendorId)}:${hex(info.usbProductId)}`, port };
    }
    async function findUsb(id) {
      const ports = typeof nav.serial?.getPorts === 'function' ? await nav.serial.getPorts() : [];
      const matches = ports.filter(port => { try { return usbDevice(port).id === id; } catch { return false; } });
      const port = matches.find(candidate => candidate === device?.port) || matches[0];
      return port ? usbDevice(port) : null;
    }
    async function readSerial(link, onLost) {
      const decoder = new TextDecoder();
      let buffer = '', ended = false;
      while (!link.stopped && !ended && link.port.readable) {
        try {
          link.reader = link.port.readable.getReader();
          for (;;) {
            const { value, done } = await link.reader.read();
            if (done) { ended = true; break; }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            if (buffer.length > 256) buffer = '';
            for (const line of lines) {
              if (link.stopped) break;
              const sample = parseSerialLine(line);
              if (sample) link.onSample(sample);
            }
          }
        } catch { /* A non-fatal read error leaves a new port.readable; a lost device leaves none. */ }
        finally { try { link.reader?.releaseLock(); } catch {} link.reader = null; }
      }
      if (link.stopped) closePort(link); else onLost();
    }
    async function attachUsb(selected, expectedGeneration) {
      if (expectedGeneration !== generation) throw cancelled();
      const expectedAttempt = ++attemptId;
      releaseTransport(); device = selected; resetTiming();
      setStatus('connecting');
      const current = () => generation === expectedGeneration && attemptId === expectedAttempt;
      try {
        await serialClosed;
        if (!current()) throw cancelled();
        // Same port settings as the hardware-verified monitor.
        await selected.port.open({ baudRate: 115200, bufferSize: 65536 });
      } catch (error) {
        if (!current()) throw cancelled();
        attemptId++; setStatus('disconnected');
        throw new Error('USB 포트를 열지 못했습니다. 시리얼 모니터 등 포트를 쓰는 프로그램을 닫고 다시 연결하세요.');
      }
      if (!current()) { selected.port.close().catch(() => {}); throw cancelled(); }
      const link = serial = { port: selected.port, reader: null, stopped: false, closed: () => {},
        onSample: sample => { if (current()) accept(sample); } };
      readSerial(link, () => handleLost(expectedGeneration, expectedAttempt));
      // An open port alone is insufficient: wait for an actual valid line.
      if (status !== 'connected') connectTimer = later(() => handleLost(expectedGeneration, expectedAttempt), 3000);
      remember();
      return true;
    }
    async function reattachUsb(expectedGeneration) {
      const found = device && await findUsb(device.id);
      if (generation !== expectedGeneration) throw cancelled();
      if (!found) throw new Error('USB 센서를 찾지 못했습니다. 케이블을 확인한 뒤 USB 연결을 다시 눌러 주세요.');
      return attachUsb(found, expectedGeneration);
    }
    // Re-plugging the same USB board resumes automatically unless the user disconnected.
    if (typeof nav.serial?.addEventListener === 'function') nav.serial.addEventListener('connect', event => {
      if (mode !== 'usb' || !autoReconnect || !device || serial || status === 'connecting' || ownerBlocked) return;
      let found;
      try { found = usbDevice(event.target); } catch { return; }
      if (found.id !== device.id) return;
      const expectedGeneration = generation;
      clearTimer('retry'); retryCount = 0;
      attachUsb(found, expectedGeneration).catch(() => scheduleRetry(expectedGeneration));
    });
    function attachWebSocket(url, expectedGeneration) {
      if (generation !== expectedGeneration) return;
      const expectedAttempt = ++attemptId;
      releaseTransport(); resetTiming();
      setStatus('connecting');
      const Socket = options.WebSocket || root.WebSocket;
      const current = () => generation === expectedGeneration && attemptId === expectedAttempt;
      try { ws = new Socket(url); }
      catch { setStatus('disconnected'); scheduleRetry(expectedGeneration); return; }
      ws.onopen = () => { if (current()) remember(); };
      ws.onmessage = event => {
        if (!current()) return;
        try {
          const data = JSON.parse(event.data);
          if (!Number.isFinite(data.force) || data.force < 0 || data.force > 100) return;
          const timestampMs = Number.isInteger(data.timestamp) && data.timestamp >= 0 && data.timestamp <= 4294967295 ? data.timestamp : null;
          accept({ timestampMs, fsrRaw: null, flexRaw: null, forceRaw: data.force }, data.force);
        } catch {}
      };
      ws.onerror = () => { if (current()) handleLost(expectedGeneration, expectedAttempt); };
      ws.onclose = () => handleLost(expectedGeneration, expectedAttempt);
      connectTimer = later(() => handleLost(expectedGeneration, expectedAttempt), 10000);
    }
    function setCalibration(cal = {}) {
      if (!ensureOwner()) throw ownerError();
      if (![cal.baseline0, cal.baseline100].every(v => Number.isFinite(v) && v >= 0 && v <= 100) || cal.baseline100 <= cal.baseline0) {
        throw new Error('기존 센서 보정 범위는 0–100 안에서 증가해야 합니다.');
      }
      calibrationRequest++; legacyCalibration = { baseline0: cal.baseline0, baseline100: cal.baseline100 };
      if (mode === 'websocket' && raw) { force = normalizeLegacy(raw.forceRaw); emit(forceListeners, force); }
      return copy(legacyCalibration);
    }
    async function loadCalibration() {
      if (!ensureOwner()) return null;
      if (isSensorMode(mode)) return currentCalibration();
      const dataService = getDataService(), originalMode = mode, request = ++calibrationRequest;
      try {
        const cal = dataService?.getCalibration ? await dataService.getCalibration() : getDataScope() === 'local' ? read('regrip_calibration') : null;
        if (!ensureOwner() || request !== calibrationRequest || mode !== originalMode || isSensorMode(mode)) return getCalibration();
        legacyCalibration = null;
        if (cal) setCalibration(cal);
        else if (mode === 'websocket' && raw) { force = raw.forceRaw; filteredAt = now(); emit(forceListeners, force); }
      } catch { /* Legacy data can be invalid or offline; it never becomes BLE raw calibration. */ }
      return getCalibration();
    }
    function captureBaseline() {
      if (!ensureOwner()) return Promise.reject(ownerError());
      if (captureTask) return Promise.reject(new Error('보정을 측정하고 있습니다. 잠시 기다려 주세요.'));
      if (!isSensorMode(mode) || !device || !isFresh()) return Promise.reject(new Error('센서 연결과 최신 수신을 먼저 확인하세요.'));
      const startedAt = now(), userKey = getUserKey(), deviceKey = device.id, connectionId = attemptId, captureMode = mode;
      const samples = [];
      return new Promise((resolve, reject) => {
        let timer;
        const finish = () => { cancel(timer); rawListeners.delete(collect); captureTask = null; };
        const fail = error => { finish(); reject(error); };
        const collect = sample => {
          if (mode !== captureMode || device?.id !== deviceKey || getUserKey() !== userKey || attemptId !== connectionId) {
            fail(new Error('기기 또는 사용자가 바뀌었습니다. 다시 보정하세요.')); return;
          }
          samples.push(sample);
        };
        captureTask = { fail }; rawListeners.add(collect);
        timer = later(() => {
          if (!ensureOwner()) return;
          const endedAt = now();
          if (!isFresh() || samples.length < 15) { fail(new Error('유효 샘플이 부족합니다. 센서 수신을 확인하고 다시 측정하세요.')); return; }
          let previous = startedAt, maxGap = 0;
          for (const sample of samples) { maxGap = Math.max(maxGap, sample.receivedAt - previous); previous = sample.receivedAt; }
          maxGap = Math.max(maxGap, endedAt - previous);
          if (maxGap > 150) { fail(new Error('센서 수신 간격이 불안정합니다. 다시 측정하세요.')); return; }
          const summarize = list => {
            const values = [...list].sort((a, b) => a - b);
            const quantile = p => { const index = (values.length - 1) * p, low = Math.floor(index); return values[low] + (values[Math.ceil(index)] - values[low]) * (index - low); };
            return { baseline: quantile(0.5), spread: quantile(0.95) - quantile(0.05) };
          };
          const result = { ...summarize(samples.map(inputValue)), sampleCount: samples.length, deviceKey, userKey, startedAt, endedAt, connectionId, channel: inputChannel(raw) };
          if (result.channel === 'finger_flex') {
            result.fingers = FINGERS.map((_, i) => ({ ...summarize(samples.map(s => s.fingerRaw[i])), connected: samples.every(s => pinConnected(s, i)) }));
          }
          finish(); resolve(result);
        }, CAPTURE_MS);
      });
    }
    function storeCalibration(snapshot) {
      const key = calibrationKey();
      if (!write(key, snapshot)) throw new Error('이 브라우저에 보정을 저장하지 못했습니다. 저장 공간 설정을 확인하세요.');
      cachedCalKey = key; sensorCalibration = snapshot;
      const target = raw ? sensorTarget(raw) : null;
      inputBlocked = !!raw && target === null;
      if (target !== null) force = target;
      filteredAt = now();
      emit(forceListeners, force); emit(statusListeners, status);
      return copy(snapshot);
    }
    function saveSensorCalibration(rest, squeeze) {
      if (!ensureOwner()) throw ownerError();
      if (!isSensorMode(mode) || !device || !isFresh()) throw new Error('최신 센서 수신이 필요합니다. 다시 연결하세요.');
      const channel = inputChannel(raw);
      for (const capture of [rest, squeeze]) {
        if ((capture?.channel || 'fsr') !== channel) throw new Error('센서 입력 종류가 바뀌었습니다. 다시 보정하세요.');
        if (!capture || capture.deviceKey !== device.id || capture.userKey !== getUserKey() || capture.connectionId !== attemptId) {
          throw new Error('보정 중 기기 또는 사용자가 바뀌었습니다. 다시 측정하세요.');
        }
        if (!Number.isFinite(capture.baseline) || capture.baseline < 0 || capture.baseline > 4095 || !Number.isFinite(capture.spread) || capture.spread < 0 || capture.sampleCount < 15
          || (channel === 'finger_flex' && !(Array.isArray(capture.fingers) && capture.fingers.length === 5))) {
          throw new Error('보정 샘플이 올바르지 않습니다. 다시 측정하세요.');
        }
      }
      if (channel === 'finger_flex') {
        const report = assessFingerCalibration(rest, squeeze);
        if (!report.some(f => f.status === 'ok')) throw new Error('보정할 수 있는 손가락이 없습니다. 센서 연결과 손을 편 상태·쥔 상태의 차이를 확인하고 다시 측정하세요.');
        return storeCalibration({ version: 3, source: mode, unit: 'adc_12bit', channel,
          fingers: report.map(f => f.status === 'ok' ? { open: f.open, closed: f.closed, use: true } : null), capturedAt: wallNow().toISOString() });
      }
      const span = Math.abs(squeeze.baseline - rest.baseline);
      if (span < MIN_SPAN) throw new Error('두 기준의 차이가 64 ADC 미만입니다. 센서 접촉을 확인하고 다시 측정하세요.');
      if (rest.spread > span * 0.2 || squeeze.spread > span * 0.2) throw new Error('센서 값의 흔들림이 큽니다. 안정된 자세에서 다시 측정하세요.');
      return storeCalibration({ version: 2, source: 'ble', unit: 'adc_12bit', channel, baseline0: rest.baseline, baseline100: squeeze.baseline, capturedAt: wallNow().toISOString() });
    }
    function setFingerSelection(use) {
      if (!ensureOwner()) throw ownerError();
      const cal = isSensorMode(mode) ? currentCalibration() : null;
      if (cal?.version !== 3) throw new Error('손가락별 보정을 먼저 저장하세요.');
      if (!Array.isArray(use) || use.length !== 5) throw new Error('손가락 선택 형식이 올바르지 않습니다.');
      if (use.some((selected, i) => selected && !cal.fingers[i])) throw new Error('보정되지 않은 손가락은 선택할 수 없습니다.');
      const fingers = cal.fingers.map((fit, i) => fit && { ...fit, use: !!use[i] });
      if (!fingers.some(fit => fit?.use)) throw new Error('게임에 사용할 손가락을 하나 이상 선택하세요.');
      return storeCalibration({ ...cal, fingers });
    }
    const api = {
      getForce: () => ensureOwner() ? force : 0,
      getMode: () => mode,
      getStatus: () => { ensureOwner(); return status; },
      getRawSample: () => ensureOwner() ? clone(raw) : null,
      getCalibration,
      getFingerReadings: () => ensureOwner() && isSensorMode(mode) ? describeFingers(raw, currentCalibration()) : null,
      getSampleRate: () => { const t = now(); return isFresh() ? arrivals.filter(at => t - at <= 1000).length : 0; },
      isInputBlocked: () => inputBlocked,
      isReady: () => ensureOwner() && (mode === 'simulation' || (isFresh() && !inputBlocked && (!isSensorMode(mode) || !!currentCalibration()))),
      getSessionContext: () => ({ inputSource: mode, calibrationSnapshot: ensureOwner() && isSensorMode(mode) ? currentCalibration() : null }),
      onForceUpdate: cb => { if (typeof cb === 'function') forceListeners.add(cb); },
      offForceUpdate: cb => forceListeners.delete(cb),
      onRawSample: cb => { if (typeof cb === 'function') rawListeners.add(cb); },
      offRawSample: cb => rawListeners.delete(cb),
      onStatusChange: cb => { if (typeof cb === 'function') statusListeners.add(cb); },
      offStatusChange: cb => statusListeners.delete(cb),
      setCalibration, loadCalibration, captureBaseline, saveSensorCalibration, setFingerSelection,
      saveBleCalibration: saveSensorCalibration,
      setSimulatedForce(value) {
        if (ensureOwner() && mode === 'simulation' && Number.isFinite(value)) { force = clamp(value); emit(forceListeners, force); }
      },
      connectBle() {
        if (!ensureOwner()) return Promise.reject(ownerError());
        const expectedGeneration = begin('ble'); autoReconnect = true; device = null;
        let choice;
        try {
          if (!secure() || typeof nav.bluetooth?.requestDevice !== 'function') throw new Error('Windows Chrome/Edge에서 HTTPS 또는 localhost 주소로 열어 주세요.');
          // Do not await anything before this call: preserve the button's user activation.
          // Both boards advertise the service UUID (ReGrip-5CH sensor PCB, ReGrip-Sensor FSR board).
          choice = nav.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }], optionalServices: [SERVICE_UUID] });
        } catch (error) { setStatus('disconnected'); return Promise.reject(error); }
        return choice.then(selected => {
          if (generation !== expectedGeneration) throw cancelled();
          device = selected; remember(); return attachBle(selected, expectedGeneration);
        }).catch(error => {
          if (generation === expectedGeneration) { setStatus('disconnected'); if (device) scheduleRetry(expectedGeneration); }
          throw error;
        });
      },
      connectUsb() {
        if (!ensureOwner()) return Promise.reject(ownerError());
        const expectedGeneration = begin('usb'); autoReconnect = true; device = null;
        let choice;
        try {
          if (!secure() || typeof nav.serial?.requestPort !== 'function') throw new Error('USB 연결은 Windows Chrome/Edge에서 HTTPS 또는 localhost 주소로 열어야 합니다.');
          // Like requestDevice, the port chooser needs the click's user activation.
          choice = nav.serial.requestPort();
        } catch (error) { setStatus('disconnected'); return Promise.reject(error); }
        return choice.then(port => {
          if (generation !== expectedGeneration) throw cancelled();
          const selected = usbDevice(port);
          device = selected; remember(); return attachUsb(selected, expectedGeneration);
        }).catch(error => {
          if (generation === expectedGeneration) { setStatus('disconnected'); if (device) scheduleRetry(expectedGeneration); }
          throw error;
        });
      },
      async restoreConnection({ explicit = false } = {}) {
        if (!ensureOwner()) return false;
        const preference = read(CONNECTION_KEY);
        if (!preference || (!explicit && !preference.autoReconnect) || preference.mode === 'simulation') return false;
        if (preference.mode === 'websocket' && preference.wsUrl) { api.connect(preference.wsUrl); return true; }
        if (preference.mode === 'usb') {
          if (!secure() || typeof nav.serial?.getPorts !== 'function' || !preference.deviceId) return false;
          const expectedGeneration = begin('usb'); autoReconnect = true;
          try {
            const found = await findUsb(preference.deviceId);
            if (generation !== expectedGeneration) return false;
            if (!found) { setStatus('disconnected'); return false; }
            device = found;
            await attachUsb(found, expectedGeneration); return true;
          } catch {
            if (generation === expectedGeneration) { setStatus('disconnected'); if (device) scheduleRetry(expectedGeneration); }
            return false;
          }
        }
        if (!secure() || typeof nav.bluetooth?.getDevices !== 'function') return false;
        const expectedGeneration = begin('ble'); autoReconnect = true;
        try {
          const granted = await nav.bluetooth.getDevices();
          if (generation !== expectedGeneration) return false;
          const selected = granted.find(d => d.id === preference.deviceId);
          if (!selected) { setStatus('disconnected'); return false; }
          device = selected;
          await attachBle(selected, expectedGeneration); return true;
        } catch {
          if (generation === expectedGeneration) { setStatus('disconnected'); if (device) scheduleRetry(expectedGeneration); }
          return false;
        }
      },
      connect(url) {
        if (!ensureOwner()) throw ownerError();
        if (typeof url !== 'string' || !/^wss?:\/\//i.test(url)) throw new Error('ws:// 또는 wss:// 센서 주소를 입력하세요.');
        const expectedGeneration = begin('websocket'); autoReconnect = true; wsUrl = url;
        remember(); attachWebSocket(url, expectedGeneration);
      },
      reconnect() {
        if (!ensureOwner()) return Promise.reject(ownerError());
        if (mode === 'ble' && device) {
          const selected = device, expectedGeneration = begin('ble'); autoReconnect = true; remember();
          return attachBle(selected, expectedGeneration).catch(error => { scheduleRetry(expectedGeneration); throw error; });
        }
        if (mode === 'usb' && device) {
          const expectedGeneration = begin('usb'); autoReconnect = true; remember();
          return reattachUsb(expectedGeneration).catch(error => {
            if (generation === expectedGeneration) { setStatus('disconnected'); scheduleRetry(expectedGeneration); }
            throw error;
          });
        }
        if (mode === 'websocket' && wsUrl) { api.connect(wsUrl); return Promise.resolve(true); }
        return api.restoreConnection({ explicit: true });
      },
      disconnect() {
        generation++; attemptId++; autoReconnect = false;
        clearTimer('retry'); abortCapture('센서 연결이 해제되어 보정을 중단했습니다.'); releaseTransport();
        setStatus(mode === 'simulation' ? 'simulation' : 'disconnected'); remember();
      },
      useSimulation() {
        if (!ensureOwner()) return;
        begin('simulation'); autoReconnect = false; force = 0;
        remember(); emit(forceListeners, force);
      },
      suspend() {
        // Navigation is not a user opt-out: the next document may restore the saved choice.
        generation++; attemptId++; clearTimer('retry');
        abortCapture('화면이 바뀌어 보정을 중단했습니다.'); releaseTransport();
        setStatus(mode === 'simulation' ? 'simulation' : 'disconnected');
      },
    };
    return api;
  }
  return { createSensorService, parseBlePacket, parseSerialLine, describeFingers, assessFingerCalibration, FINGERS, SERVICE_UUID, TX_UUID };
});
