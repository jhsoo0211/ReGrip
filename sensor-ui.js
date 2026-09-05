/* Shared connection controls. Device state comes only from SensorService. */
(function (root) {
  'use strict';
  let bootstrapped = false;
  const labels = { simulation: '시뮬레이션', connecting: '연결 중', connected: '센서 연결됨', stale: '센서 응답 없음', disconnected: '연결 끊김' };
  function mount(host, options = {}) {
    if (!host) return () => {};
    const sensor = root.SensorService;
    host.classList.add('sensor-panel');
    host.innerHTML = `
      <div class="sensor-panel-heading"><strong data-sensor-status role="status"></strong><span data-sensor-mode></span></div>
      <p class="sensor-panel-help" data-sensor-help></p>
      <div class="sensor-panel-actions">
        <button type="button" data-ble-connect>센서 연결</button>
        <a href="calibration.html" data-calibrate>센서 보정</a>
        <button type="button" class="sensor-secondary" data-simulate>시뮬레이션 사용</button>
        <button type="button" class="sensor-secondary" data-disconnect>연결 해제</button>
      </div>
      <p class="sensor-panel-error" data-sensor-error role="alert" hidden></p>
      <details class="sensor-diagnostics" ${options.diagnostics ? 'open' : ''}>
        <summary>센서 입력 확인</summary>
        <div class="sensor-readings"><span>압력 <b data-fsr>—</b> <small data-fsr-unit>ADC</small></span><span>가변 저항 <b data-flex>—</b><small> ADC</small></span></div>
        <canvas width="520" height="116" aria-label="압력 센서와 가변 저항 입력 그래프"></canvas>
        <p class="sensor-panel-help" data-plot-help>파랑: 압력 · 보라: 가변저항. 게임 조작에는 압력만 사용합니다.</p>
        <div class="sensor-ws"><label>기존 Wi-Fi 센서 주소<input data-ws-url type="url" placeholder="ws://192.168.4.1:8080" /></label><button type="button" class="sensor-secondary" data-ws-connect>Wi-Fi 연결</button></div>
      </details>`;
    if (options.compact) host.classList.add('sensor-panel-compact');
    const $ = s => host.querySelector(s);
    const error = $('[data-sensor-error]');
    const frames = [];
    let destroyed = false, busy = false, plotMode = sensor.getMode();
    const canvas = $('canvas'), context = canvas.getContext('2d');
    const status = () => {
      if (destroyed) return;
      const mode = sensor.getMode(), current = sensor.getStatus();
      if (mode !== plotMode || current === 'connecting' || current === 'simulation') {
        frames.length = 0; plotMode = mode;
        $('[data-fsr]').textContent = '—'; $('[data-flex]').textContent = '—';
        if (context) context.clearRect(0, 0, canvas.width, canvas.height);
      }
      $('[data-fsr-unit]').textContent = mode === 'websocket' ? '%' : 'ADC';
      $('[data-plot-help]').textContent = mode === 'websocket'
        ? '파랑: Wi-Fi 센서의 보정 전 압력(%). 이 센서는 가변 저항 값을 전송하지 않습니다.'
        : '파랑: 압력 · 보라: 가변저항. 게임 조작에는 압력만 사용합니다.';
      $('[data-sensor-status]').textContent = labels[current] || current;
      $('[data-sensor-mode]').textContent = mode === 'ble' ? 'Bluetooth' : mode === 'websocket' ? 'Wi-Fi' : '키보드·터치';
      const needsCal = mode === 'ble' && current === 'connected' && !sensor.isReady();
      $('[data-sensor-help]').textContent = needsCal ? '연결됐습니다. 게임 시작 전 내 손에 맞게 보정해 주세요.'
        : sensor.isReady() ? (mode === 'simulation' ? '센서 없이 연습할 수 있습니다. 기록은 시뮬레이션으로 구분됩니다.' : '준비됐습니다. 편안하게 쥐고 힘을 조절해 보세요.')
        : current === 'connecting' ? '센서를 연결 중입니다. 장치 목록에서 ReGrip-Sensor를 선택해 주세요.'
        : '센서 입력이 멈추면 게임도 멈춥니다. 연결을 확인한 뒤 직접 재개해 주세요.';
      $('[data-ble-connect]').disabled = busy;
      $('[data-ble-connect]').textContent = mode !== 'simulation' && current !== 'connected' ? '센서 다시 연결' : '센서 연결';
      $('[data-disconnect]').hidden = mode === 'simulation';
      $('[data-calibrate]').hidden = mode === 'simulation';
      $('[data-simulate]').hidden = mode === 'simulation';
    };
    function plot(sample) {
      if (destroyed || !sample) return;
      const pressure = sensor.getMode() === 'websocket' ? sample.forceRaw : sample.fsrRaw;
      $('[data-fsr]').textContent = pressure == null ? '—' : String(Math.round(pressure));
      $('[data-flex]').textContent = sample.flexRaw == null ? '—' : String(Math.round(sample.flexRaw));
      frames.push({ pressure, flex: sample.flexRaw }); if (frames.length > 100) frames.shift();
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      const max = sensor.getMode() === 'websocket' ? 100 : 4095;
      for (const [field, color] of [['pressure','#2863aa'],['flex','#8861ba']]) {
        context.beginPath(); context.strokeStyle = color; context.lineWidth = 2;
        let started = false;
        frames.forEach((f, i) => { if (!Number.isFinite(f[field])) return; const x=i*canvas.width/99, y=canvas.height-6-f[field]/max*(canvas.height-12); if(!started) { context.moveTo(x,y); started=true; } else context.lineTo(x,y); });
        context.stroke();
      }
    }
    async function act(fn) {
      error.hidden = true; busy = true; status();
      try { await fn(); } catch (e) { if (!destroyed) { error.textContent = e && e.name === 'NotFoundError' ? '장치 선택을 취소했습니다. 준비되면 다시 연결해 주세요.' : (e.message || '연결하지 못했습니다. 다시 시도해 주세요.'); error.hidden = false; } }
      finally { busy = false; status(); }
    }
    $('[data-ble-connect]').onclick = () => act(() => sensor.connectBle());
    $('[data-ws-connect]').onclick = () => act(() => {
      const url = $('[data-ws-url]').value.trim();
      if (!/^wss?:\/\//.test(url)) throw new Error('ws:// 또는 wss://로 시작하는 주소를 입력해 주세요.');
      sensor.connect(url);
      return sensor.loadCalibration();
    });
    $('[data-disconnect]').onclick = () => { sensor.disconnect(); status(); };
    $('[data-simulate]').onclick = () => { sensor.useSimulation(); status(); };
    sensor.onStatusChange(status); sensor.onRawSample(plot); status();
    if (!bootstrapped) {
      bootstrapped = true;
      Promise.resolve(sensor.restoreConnection()).catch(() => {}).then(() => { if (sensor.getMode() === 'websocket') return sensor.loadCalibration(); }).finally(status);
    }
    const cleanup = () => { destroyed = true; sensor.offStatusChange(status); sensor.offRawSample(plot); root.removeEventListener('pagehide',cleanup); };
    root.addEventListener('pagehide', cleanup, {once:true});
    return cleanup;
  }
  root.addEventListener('pagehide', () => root.SensorService.suspend());
  // pagehide also tears down each game's listeners. Rebuild every page together on BFCache return.
  root.addEventListener('pageshow', event => { if (event.persisted) root.location.reload(); });
  root.ReGripSensorUI = { mount };
})(globalThis);
