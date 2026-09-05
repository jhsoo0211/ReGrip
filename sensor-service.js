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
  const clamp = value => Math.max(0, Math.min(100, value));
  const clone = value => value ? { ...value } : null;

  function parseBlePacket(payload) {
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

  function validBleCalibration(cal) {
    return cal && cal.version === 2 && cal.source === 'ble' && cal.unit === 'adc_12bit' && cal.channel === 'fsr'
      && [cal.baseline0, cal.baseline100].every(v => Number.isFinite(v) && v >= 0 && v <= 4095)
      && Math.abs(cal.baseline100 - cal.baseline0) >= MIN_SPAN
      && typeof cal.capturedAt === 'string' && Number.isFinite(Date.parse(cal.capturedAt));
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
    let mode = ['ble', 'websocket'].includes(saved?.mode) ? saved.mode : 'simulation';
    let status = mode === 'simulation' ? 'simulation' : 'disconnected';
    let force = 0, raw = null, filteredAt = null, lastTimestamp = null, lastReceivedAt = null;
    let device = null, characteristic = null, ws = null, wsUrl = saved?.wsUrl || null;
    let packetListener = null, disconnectListener = null;
    let generation = 0, attemptId = 0, retryCount = 0, retryTimer = null, staleTimer = null, connectTimer = null;
    let autoReconnect = saved?.autoReconnect !== false;
    let legacyCalibration = null, cachedCalKey = null, bleCalibration = null, captureTask = null;
    let documentOwner = null, ownerBlocked = false, calibrationRequest = 0;
    const forceListeners = new Set(), rawListeners = new Set(), statusListeners = new Set();

    function emit(list, value) { for (const cb of list) { try { cb(value); } catch {} } }
    function setStatus(next) { if (next !== status) { status = next; emit(statusListeners, status); } }
    function ensureOwner() {
      if (ownerBlocked) return false;
      const currentOwner = getUserKey();
      if (documentOwner === null) documentOwner = currentOwner;
      if (documentOwner === currentOwner) return true;
      // A cached page must never finish an earlier owner's game or reuse their normalization.
      ownerBlocked = true; generation++; attemptId++; calibrationRequest++;
      clearTimer('retry'); abortCapture(ownerError().message); releaseTransport();
      force = 0; raw = null; filteredAt = null; lastTimestamp = null; lastReceivedAt = null;
      legacyCalibration = null; cachedCalKey = null; bleCalibration = null;
      setStatus('disconnected'); emit(forceListeners, force);
      return false;
    }
    function isFresh() { return lastReceivedAt !== null && now() - lastReceivedAt < FRESH_MS && status === 'connected'; }
    function calibrationKey() { return device ? CAL_PREFIX + encodeURIComponent(getUserKey()) + ':' + encodeURIComponent(device.id) : null; }
    function currentBleCalibration() {
      const key = calibrationKey();
      if (key !== cachedCalKey) {
        cachedCalKey = key;
        const stored = key ? read(key) : null;
        bleCalibration = validBleCalibration(stored) ? stored : null;
      }
      return clone(bleCalibration);
    }
    function getCalibration() { return ensureOwner() ? (mode === 'ble' ? currentBleCalibration() : mode === 'websocket' ? clone(legacyCalibration) : null) : null; }
    function abortCapture(message) { if (captureTask) captureTask.fail(new Error(message)); }
    function clearTimer(name) {
      if (name === 'retry') { if (retryTimer !== null) cancel(retryTimer); retryTimer = null; }
      if (name === 'stale') { if (staleTimer !== null) cancel(staleTimer); staleTimer = null; }
      if (name === 'connect') { if (connectTimer !== null) cancel(connectTimer); connectTimer = null; }
    }
    function remember() {
      write(CONNECTION_KEY, { mode, deviceId: device?.id || saved?.deviceId || null, wsUrl, autoReconnect });
    }
    function releaseTransport() {
      clearTimer('stale'); clearTimer('connect');
      if (characteristic && packetListener) characteristic.removeEventListener('characteristicvaluechanged', packetListener);
      if (device && disconnectListener) device.removeEventListener('gattserverdisconnected', disconnectListener);
      characteristic = null; packetListener = null; disconnectListener = null;
      if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch {} ws = null; }
      // disconnect() also cancels an in-flight GATT connection in supporting browsers.
      if (device?.gatt) { try { device.gatt.disconnect(); } catch {} }
    }
    function begin(nextMode) {
      generation++; attemptId++; clearTimer('retry'); retryCount = 0;
      abortCapture('연결이 바뀌어 보정을 중단했습니다. 다시 측정하세요.');
      releaseTransport(); mode = nextMode;
      raw = null; filteredAt = null; lastTimestamp = null; lastReceivedAt = null;
      cachedCalKey = null; bleCalibration = null;
      setStatus(nextMode === 'simulation' ? 'simulation' : 'connecting');
      return generation;
    }
    function normalize(value) {
      const cal = mode === 'ble' ? currentBleCalibration() : legacyCalibration;
      return cal ? clamp((value - cal.baseline0) / (cal.baseline100 - cal.baseline0) * 100) : clamp(mode === 'ble' ? value / 4095 * 100 : value);
    }
    function accept(sample, input) {
      if (!ensureOwner()) return;
      if (lastTimestamp !== null && sample.timestampMs !== null) {
        const delta = (sample.timestampMs - lastTimestamp) >>> 0;
        if (delta === 0 || delta > 2147483647) return;
      }
      const receivedAt = now(), wasFresh = isFresh();
      lastTimestamp = sample.timestampMs;
      lastReceivedAt = receivedAt;
      raw = Object.freeze({ ...sample, receivedAt });
      const target = normalize(input);
      force = filteredAt === null || !wasFresh ? target : force + (target - force) * (1 - Math.exp(-(receivedAt - filteredAt) / FILTER_MS));
      filteredAt = receivedAt;
      clearTimer('connect'); clearTimer('stale'); retryCount = 0;
      setStatus('connected');
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
      if (expectedGeneration !== generation) throw new Error('연결 요청이 취소되었습니다.');
      const expectedAttempt = ++attemptId;
      releaseTransport(); device = selected; lastTimestamp = null; filteredAt = null; lastReceivedAt = null;
      setStatus('connecting');
      const current = () => generation === expectedGeneration && attemptId === expectedAttempt;
      const work = async () => {
        const server = await selected.gatt.connect();
        if (!current()) throw new Error('연결 요청이 취소되었습니다.');
        const service = await server.getPrimaryService(SERVICE_UUID);
        const tx = await service.getCharacteristic(TX_UUID);
        if (!current()) throw new Error('연결 요청이 취소되었습니다.');
        characteristic = tx;
        packetListener = event => {
          if (!current()) return;
          const sample = parseBlePacket(event.target.value);
          if (sample) accept(sample, sample.fsrRaw);
        };
        disconnectListener = () => handleLost(expectedGeneration, expectedAttempt);
        selected.addEventListener('gattserverdisconnected', disconnectListener);
        tx.addEventListener('characteristicvaluechanged', packetListener);
        await tx.startNotifications();
        if (!current()) throw new Error('연결 요청이 취소되었습니다.');
      };
      let timeout;
      try {
        await Promise.race([work(), new Promise((_, reject) => {
          timeout = later(() => reject(new Error('센서 연결 시간이 초과되었습니다. 전원과 거리를 확인하세요.')), 10000);
        })]);
        if (!current()) throw new Error('연결 요청이 취소되었습니다.');
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
    function attachWebSocket(url, expectedGeneration) {
      if (generation !== expectedGeneration) return;
      const expectedAttempt = ++attemptId;
      releaseTransport(); lastTimestamp = null; filteredAt = null; lastReceivedAt = null;
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
      if (mode === 'websocket' && raw) { force = normalize(raw.forceRaw); emit(forceListeners, force); }
      return clone(legacyCalibration);
    }
    async function loadCalibration() {
      if (!ensureOwner()) return null;
      if (mode === 'ble') return currentBleCalibration();
      const dataService = getDataService(), originalMode = mode, request = ++calibrationRequest;
      try {
        const cal = dataService?.getCalibration ? await dataService.getCalibration() : getDataScope() === 'local' ? read('regrip_calibration') : null;
        if (!ensureOwner() || request !== calibrationRequest || mode !== originalMode || mode === 'ble') return getCalibration();
        legacyCalibration = null;
        if (cal) setCalibration(cal);
        else if (mode === 'websocket' && raw) { force = raw.forceRaw; filteredAt = now(); emit(forceListeners, force); }
      } catch { /* Legacy data can be invalid or offline; it never becomes BLE raw calibration. */ }
      return getCalibration();
    }
    function captureBaseline() {
      if (!ensureOwner()) return Promise.reject(ownerError());
      if (captureTask) return Promise.reject(new Error('보정을 측정하고 있습니다. 잠시 기다려 주세요.'));
      if (mode !== 'ble' || !device || !isFresh()) return Promise.reject(new Error('센서 연결과 최신 수신을 먼저 확인하세요.'));
      const startedAt = now(), userKey = getUserKey(), deviceKey = device.id, connectionId = attemptId;
      const samples = [];
      return new Promise((resolve, reject) => {
        let timer;
        const finish = () => { cancel(timer); rawListeners.delete(collect); captureTask = null; };
        const fail = error => { finish(); reject(error); };
        const collect = sample => {
          if (mode !== 'ble' || device?.id !== deviceKey || getUserKey() !== userKey || attemptId !== connectionId) {
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
          const values = samples.map(s => s.fsrRaw).sort((a, b) => a - b);
          const quantile = p => { const index = (values.length - 1) * p, low = Math.floor(index); return values[low] + (values[Math.ceil(index)] - values[low]) * (index - low); };
          const result = { baseline: quantile(0.5), spread: quantile(0.95) - quantile(0.05), sampleCount: samples.length, deviceKey, userKey, startedAt, endedAt, connectionId };
          finish(); resolve(result);
        }, CAPTURE_MS);
      });
    }
    function saveBleCalibration(rest, squeeze) {
      if (!ensureOwner()) throw ownerError();
      if (mode !== 'ble' || !device || !isFresh()) throw new Error('최신 센서 수신이 필요합니다. 다시 연결하세요.');
      for (const capture of [rest, squeeze]) {
        if (!capture || capture.deviceKey !== device.id || capture.userKey !== getUserKey() || capture.connectionId !== attemptId) {
          throw new Error('보정 중 기기 또는 사용자가 바뀌었습니다. 다시 측정하세요.');
        }
        if (!Number.isFinite(capture.baseline) || capture.baseline < 0 || capture.baseline > 4095 || !Number.isFinite(capture.spread) || capture.spread < 0 || capture.sampleCount < 15) {
          throw new Error('보정 샘플이 올바르지 않습니다. 다시 측정하세요.');
        }
      }
      const span = Math.abs(squeeze.baseline - rest.baseline);
      if (span < MIN_SPAN) throw new Error('두 기준의 차이가 64 ADC 미만입니다. 센서 접촉을 확인하고 다시 측정하세요.');
      if (rest.spread > span * 0.2 || squeeze.spread > span * 0.2) throw new Error('센서 값의 흔들림이 큽니다. 안정된 자세에서 다시 측정하세요.');
      const snapshot = { version: 2, source: 'ble', unit: 'adc_12bit', channel: 'fsr', baseline0: rest.baseline, baseline100: squeeze.baseline, capturedAt: wallNow().toISOString() };
      const key = calibrationKey();
      if (!write(key, snapshot)) throw new Error('이 브라우저에 보정을 저장하지 못했습니다. 저장 공간 설정을 확인하세요.');
      cachedCalKey = key; bleCalibration = snapshot;
      force = normalize(raw.fsrRaw); filteredAt = now();
      emit(forceListeners, force); emit(statusListeners, status);
      return clone(snapshot);
    }
    const api = {
      getForce: () => ensureOwner() ? force : 0,
      getMode: () => mode,
      getStatus: () => { ensureOwner(); return status; },
      getRawSample: () => ensureOwner() ? clone(raw) : null,
      getCalibration,
      isReady: () => ensureOwner() && (mode === 'simulation' || (isFresh() && (mode !== 'ble' || !!currentBleCalibration()))),
      getSessionContext: () => ({ inputSource: mode, calibrationSnapshot: ensureOwner() && mode === 'ble' ? currentBleCalibration() : null }),
      onForceUpdate: cb => { if (typeof cb === 'function') forceListeners.add(cb); },
      offForceUpdate: cb => forceListeners.delete(cb),
      onRawSample: cb => { if (typeof cb === 'function') rawListeners.add(cb); },
      offRawSample: cb => rawListeners.delete(cb),
      onStatusChange: cb => { if (typeof cb === 'function') statusListeners.add(cb); },
      offStatusChange: cb => statusListeners.delete(cb),
      setCalibration, loadCalibration, captureBaseline, saveBleCalibration,
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
          choice = nav.bluetooth.requestDevice({ filters: [{ name: 'ReGrip-Sensor' }], optionalServices: [SERVICE_UUID] });
        } catch (error) { setStatus('disconnected'); return Promise.reject(error); }
        return choice.then(selected => {
          if (generation !== expectedGeneration) throw new Error('연결 요청이 취소되었습니다.');
          device = selected; remember(); return attachBle(selected, expectedGeneration);
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
  return { createSensorService, parseBlePacket, SERVICE_UUID, TX_UUID };
});
