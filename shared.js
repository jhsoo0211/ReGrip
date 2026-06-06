/* ReGrip — Shared JS */

// ── Navigation ──────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { key: 'home',         label: '홈',   icon: 'home',              href: 'index.html' },
  { key: 'training',     label: '훈련', icon: 'fitness_center',    href: 'training.html' },
  { key: 'history',      label: '기록', icon: 'timeline',          href: 'history.html' },
  { key: 'achievements', label: '업적', icon: 'workspace_premium', href: 'achievements.html' },
  { key: 'settings',     label: '설정', icon: 'settings',          href: 'settings.html' },
];

function injectNav(activeKey) {
  const sidebar = document.getElementById('nav-sidebar');
  const bottom  = document.getElementById('nav-bottom');
  if (!sidebar || !bottom) return;

  const profile = DataService.getProfileSync();
  const userName   = profile.name || 'ReGrip 사용자';
  const avatarSrc  = profile.avatarBase64 || 'https://lh3.googleusercontent.com/aida-public/AB6AXuAMD1C_MGkOFfAqI9jQHYlgL_uT4Mol13UMOieb5zW6vv9HR8PZzl4r0P_6cJeWzKiRZYRAOTJlzJglaAKqo4xkycQn4MXGHCCzI9LAjRS2Fx_KrcEXFH7jn9kXiMBicZW1voTZ-gA05R0gvzJPd8Qk8-po2W-MfoBauuZ0Q13ASGls1awQYOXR3c5aBqBHQxgA4_ZrFZ4aMDQHLRSwbeDck73EFwM4c1s9L6ijUXzb8FbZAL2Cw2rHCCcpCKucafQPWS6Iba3tT58';

  const linksHtml = NAV_ITEMS.map(item => {
    const active = item.key === activeKey ? 'active' : '';
    const fill   = item.key === activeKey ? "style=\"font-variation-settings:'FILL' 1\"" : '';
    return `<a class="nav-item ${active}" href="${item.href}">
      <span class="material-symbols-outlined" ${fill}>${item.icon}</span>
      ${item.label}
    </a>`;
  }).join('');

  sidebar.innerHTML = `
    <div class="nav-logo">ReGrip</div>
    <a class="nav-user" href="profile.html" style="text-decoration:none;color:inherit;">
      <img src="${avatarSrc}" alt="프로필" onerror="this.src='https://lh3.googleusercontent.com/aida-public/AB6AXuAMD1C_MGkOFfAqI9jQHYlgL_uT4Mol13UMOieb5zW6vv9HR8PZzl4r0P_6cJeWzKiRZYRAOTJlzJglaAKqo4xkycQn4MXGHCCzI9LAjRS2Fx_KrcEXFH7jn9kXiMBicZW1voTZ-gA05R0gvzJPd8Qk8-po2W-MfoBauuZ0Q13ASGls1awQYOXR3c5aBqBHQxgA4_ZrFZ4aMDQHLRSwbeDck73EFwM4c1s9L6ijUXzb8FbZAL2Cw2rHCCcpCKucafQPWS6Iba3tT58'"/>
      <div>
        <div class="nav-user-name">${userName}</div>
        <div class="nav-user-sub">재활 진행 중 · 프로필 편집</div>
      </div>
    </a>
    <a class="nav-start-btn" href="training.html">
      <span class="material-symbols-outlined">play_arrow</span>
      훈련 시작
    </a>
    <div class="nav-links">${linksHtml}</div>
    <button class="nav-sensor-btn" onclick="openFeedbackModal()">
      <span style="display:flex;align-items:center;gap:6px;">
        <span class="material-symbols-outlined" style="font-size:18px;color:#16A34A;font-variation-settings:'FILL' 1">sensors</span>
        센서 연결됨
      </span>
      <span style="width:8px;height:8px;border-radius:50%;background:#16A34A;display:inline-block;"></span>
    </button>
  `;

  const bottomLinksHtml = NAV_ITEMS.map(item => {
    const active = item.key === activeKey ? 'active' : '';
    const fill   = item.key === activeKey ? "style=\"font-variation-settings:'FILL' 1\"" : '';
    return `<a class="nav-bottom-item ${active}" href="${item.href}">
      <span class="material-symbols-outlined" ${fill}>${item.icon}</span>
      ${item.label}
    </a>`;
  }).join('');

  bottom.innerHTML = bottomLinksHtml;
}

// ── Feedback / Error Modal ────────────────────────────────────────────────────
function openFeedbackModal(context) {
  const modal = document.getElementById('feedback-modal');
  if (modal) modal.classList.add('open');
}
function closeFeedbackModal() {
  const modal = document.getElementById('feedback-modal');
  if (modal) modal.classList.remove('open');
}

function injectFeedbackModal() {
  if (document.getElementById('feedback-modal')) return;
  const el = document.createElement('div');
  el.id = 'feedback-modal';
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('role', 'dialog');
  el.innerHTML = `
    <div class="modal-card">
      <div class="modal-banner">
        <span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">warning</span>
        시스템 알림
      </div>
      <div class="modal-body">
        <div class="modal-icon">
          <span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">sensors_off</span>
          <div class="modal-badge">!</div>
        </div>
        <h2>연결이 끊어졌습니다.</h2>
        <p>센서를 다시 확인해 주세요. 장치가 올바르게 착용되었는지, 배터리가 충분한지 확인하시기 바랍니다.</p>
        <div class="modal-actions">
          <button class="btn-primary" onclick="SensorService.reconnect(); closeFeedbackModal()">
            <span class="material-symbols-outlined">restart_alt</span>
            재연결 시도
          </button>
          <button class="btn-secondary" onclick="closeFeedbackModal()">
            <span class="material-symbols-outlined">close</span>
            닫기
          </button>
        </div>
      </div>
      <div class="modal-hint">
        <span class="material-symbols-outlined" style="color:#994626;margin-top:2px;flex-shrink:0">help</span>
        <span><strong>도움말:</strong> 센서 표시등이 파란색으로 깜빡이면 페어링 모드입니다. 기기의 설정에서 'ReGrip Sensor'를 선택하세요.</span>
      </div>
    </div>
  `;
  el.addEventListener('click', e => { if (e.target === el) closeFeedbackModal(); });
  document.body.appendChild(el);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA SERVICE — localStorage now, REST API later
// To switch to REST: call DataService.setBackend('rest', 'https://api.yourserver.com')
// ═══════════════════════════════════════════════════════════════════════════════
const DataService = {
  _backend: 'local',   // 'local' | 'rest'
  _baseUrl: '',

  setBackend(type, baseUrl = '') {
    this._backend = type;
    this._baseUrl = baseUrl;
  },

  // ── Profile ──
  getProfileSync() {
    try { return JSON.parse(localStorage.getItem('regrip_profile')) || {}; }
    catch { return {}; }
  },

  async getProfile() {
    if (this._backend === 'rest') {
      const r = await fetch(`${this._baseUrl}/api/profile`);
      return r.json();
    }
    return this.getProfileSync();
  },

  async saveProfile(data) {
    if (this._backend === 'rest') {
      await fetch(`${this._baseUrl}/api/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } else {
      localStorage.setItem('regrip_profile', JSON.stringify(data));
    }
  },

  // ── Sessions ──
  async getSessions() {
    if (this._backend === 'rest') {
      const r = await fetch(`${this._baseUrl}/api/sessions`);
      return r.json();
    }
    try { return JSON.parse(localStorage.getItem('regrip_sessions')) || []; }
    catch { return []; }
  },

  async saveSession(data) {
    if (this._backend === 'rest') {
      await fetch(`${this._baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } else {
      const sessions = await this.getSessions();
      sessions.unshift({ ...data, id: Date.now() });
      localStorage.setItem('regrip_sessions', JSON.stringify(sessions));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SENSOR SERVICE — simulation now, WebSocket / Serial later
//
// Arduino/RPi integration:
//   1. Run a WebSocket server on the device (port 8080)
//   2. Send JSON: { "force": 73.5, "timestamp": 1717648200000 }
//   3. Call: SensorService.connect('ws://localhost:8080')
//
// ═══════════════════════════════════════════════════════════════════════════════
const SensorService = {
  _ws: null,
  _mode: 'simulation',   // 'simulation' | 'websocket'
  _force: 0,
  _callbacks: [],
  _reconnectTimer: null,
  _wsUrl: null,

  connect(wsUrl) {
    this._wsUrl = wsUrl;
    this._mode = 'websocket';
    this._ws = new WebSocket(wsUrl);

    this._ws.onopen = () => {
      console.log('[SensorService] Connected to', wsUrl);
      clearTimeout(this._reconnectTimer);
    };

    this._ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.force === 'number') {
          this._force = Math.max(0, Math.min(100, data.force));
          this._callbacks.forEach(cb => cb(this._force));
        }
      } catch {}
    };

    this._ws.onerror = () => {
      console.warn('[SensorService] WebSocket error, falling back to simulation');
      this._mode = 'simulation';
    };

    this._ws.onclose = () => {
      if (this._mode === 'websocket') {
        console.log('[SensorService] Disconnected, retrying in 3s...');
        this._reconnectTimer = setTimeout(() => this.connect(wsUrl), 3000);
      }
    };
  },

  reconnect() {
    if (this._wsUrl) this.connect(this._wsUrl);
  },

  disconnect() {
    clearTimeout(this._reconnectTimer);
    if (this._ws) { this._ws.onclose = null; this._ws.close(); this._ws = null; }
    this._mode = 'simulation';
    this._wsUrl = null;
  },

  onForceUpdate(cb)    { this._callbacks.push(cb); },
  offForceUpdate(cb)   { this._callbacks = this._callbacks.filter(c => c !== cb); },
  getForce()           { return this._force; },
  getMode()            { return this._mode; },

  // Called by game loops when in simulation mode
  setSimulatedForce(v) {
    if (this._mode === 'simulation') {
      this._force = Math.max(0, Math.min(100, v));
      this._callbacks.forEach(cb => cb(this._force));
    }
  },
};

// ── Legacy helpers (kept for backwards-compat with history.html) ─────────────
function loadSessions()     { return JSON.parse(localStorage.getItem('regrip_sessions') || '[]'); }
function saveSession(data)  { DataService.saveSession(data); }

function seedMockData() {
  if (loadSessions().length > 0) return;
  const now = Date.now();
  const DAY = 86400000;
  const exercises = ['완전 그립 훈련', '핀치 그립 훈련', '측면 그립 훈련', '손가락 펴기'];
  const mock = Array.from({ length: 14 }, (_, i) => ({
    id: now - i * DAY,
    date: new Date(now - i * DAY).toISOString(),
    label: exercises[i % exercises.length],
    durationMin: 15 + Math.floor(Math.random() * 20),
    sets: 4 + Math.floor(Math.random() * 5),
    avgForce: 45 + Math.floor(Math.random() * 40),
    maxForce: 65 + Math.floor(Math.random() * 30),
    stars: 1 + Math.floor(Math.random() * 3),
  }));
  localStorage.setItem('regrip_sessions', JSON.stringify(mock));
}

function formatKoreanDate(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
}

// ── Exercise presets ──────────────────────────────────────────────────────────
const EXERCISE_SETS = [
  { id: 'pinch_hold',   label: '핀치 그립 유지', desc: '두 손가락으로 가볍게 쥐세요',     reps: 8,  holdSecs: 3, targetPct: [40, 60] },
  { id: 'full_grip',    label: '완전 쥐기',      desc: '손 전체로 최대한 꽉 쥐세요',     reps: 6,  holdSecs: 5, targetPct: [60, 80] },
  { id: 'finger_ext',   label: '손가락 펴기',    desc: '손가락을 천천히 활짝 펴세요',     reps: 10, holdSecs: 2, targetPct: [20, 40] },
  { id: 'lateral_grip', label: '측면 그립',      desc: '엄지와 검지로 옆면을 잡으세요',   reps: 8,  holdSecs: 3, targetPct: [50, 70] },
];

// ── Init ─────────────────────────────────────────────────────────────────────
function initPage(activeKey) {
  injectNav(activeKey);
  injectFeedbackModal();
  seedMockData();
}
