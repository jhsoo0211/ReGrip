/* ReGrip — Shared JS
 *
 * Public surface (used by page scripts):
 *   DataService          — localStorage-first data layer, REST-switchable
 *   SensorService        — WebSocket sensor with simulation fallback + status machine
 *   GamificationEngine   — single source of truth for XP / levels / achievements / stats
 *   GAME_DEFS, starsForScore, iconForSession, gameIdOf, mulberry32, deriveSetDetails
 *   injectNav, initPage, formatKoreanDate
 *   renderSensorStatus, bindSensorBadge
 *   seedDemoData, renderEmptyState, animateCount, prefersReducedMotion, openConfirmModal
 */

// ── Navigation ──────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { key: 'home',         label: '홈',   icon: 'home',              href: 'index.html' },
  { key: 'training',     label: '훈련', icon: 'fitness_center',    href: 'training.html' },
  { key: 'history',      label: '기록', icon: 'timeline',          href: 'history.html' },
  { key: 'achievements', label: '업적', icon: 'workspace_premium', href: 'achievements.html' },
  { key: 'settings',     label: '설정', icon: 'settings',          href: 'settings.html' },
];

// Inline SVG default avatar (retro person glyph) — no external hotlink, works offline.
const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' fill='%23FFE9E3'/%3E%3Ccircle cx='48' cy='36' r='16' fill='%23994626'/%3E%3Cpath d='M16 90c4-20 17-28 32-28s28 8 32 28z' fill='%23994626'/%3E%3C/svg%3E";

function injectNav(activeKey) {
  const sidebar = document.getElementById('nav-sidebar');
  const bottom  = document.getElementById('nav-bottom');
  if (!sidebar || !bottom) return;

  const profile = DataService.getProfileSync();
  const userName   = profile.name || 'ReGrip 사용자';
  const avatarSrc  = profile.avatarBase64 || DEFAULT_AVATAR;

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
      <img src="${avatarSrc}" alt="프로필 사진" onerror="this.src='${DEFAULT_AVATAR}'"/>
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
    <button id="nav-sensor-status" class="nav-sensor-btn" type="button" onclick="openFeedbackModal()"></button>
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

  // Fill the freshly created badge with the current sensor state.
  renderSensorStatus();
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
//
// localStorage mirror keys:
//   regrip_profile      — profile object (11 fields)
//   regrip_sessions     — session array (newest first)
//   regrip_settings     — { hand, difficulty, restSeconds, reducedMotion, ... }
//   regrip_calibration  — { baseline0, baseline100 }
//
// To switch to REST:
//   DataService.setBackend('rest', 'https://api.yourserver.com', { Authorization: 'Bearer …' })
//
// REST design: every getX mirrors the response into localStorage (cache pattern) so the
// synchronous getXSync() mirrors keep working offline; every saveX also writes the mirror
// and, on network failure, warns + persists locally to avoid data loss.
// ═══════════════════════════════════════════════════════════════════════════════
const DataService = {
  _backend: 'local',   // 'local' | 'rest'
  _baseUrl: '',
  _headers: {},

  setBackend(type, baseUrl = '', headers = {}) {
    this._backend = type;
    this._baseUrl = baseUrl;
    this._headers = { ...this._headers, ...headers };
  },

  // ── localStorage helpers ──
  _readLocal(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch { return fallback; }
  },
  _writeLocal(key, data) {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {
      console.warn(`[DataService] localStorage write failed for ${key}:`, e && e.message);
    }
  },

  // ── REST helper ──
  // Returns parsed JSON on success ({} when body is empty), or null on any failure.
  async _fetch(path, opts = {}) {
    try {
      const headers = { ...this._headers, ...(opts.headers || {}) };
      let body = opts.body;
      if (body !== undefined && typeof body !== 'string') {
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const res = await fetch(this._baseUrl + path, { ...opts, headers, body });
      if (!res.ok) {
        console.warn(`[DataService] ${opts.method || 'GET'} ${path} → HTTP ${res.status}`);
        return null;
      }
      const text = await res.text();
      if (!text) return {};
      try { return JSON.parse(text); } catch { return {}; }
    } catch (e) {
      console.warn(`[DataService] ${opts.method || 'GET'} ${path} failed:`, e && e.message);
      return null;
    }
  },

  // ── Profile ──
  getProfileSync() {
    return this._readLocal('regrip_profile', {});   // localStorage mirror
  },

  async getProfile() {
    if (this._backend === 'rest') {
      const data = await this._fetch('/api/profile');
      if (data) { this._writeLocal('regrip_profile', data); return data; }  // refresh cache mirror
      return this.getProfileSync();                                         // fallback to mirror
    }
    return this.getProfileSync();
  },

  async saveProfile(data) {
    if (this._backend === 'rest') {
      const res = await this._fetch('/api/profile', { method: 'PUT', body: data });
      if (res === null) console.warn('[DataService] saveProfile REST 실패 — 로컬에 저장합니다.');
      this._writeLocal('regrip_profile', data);   // keep mirror in sync (and offline fallback)
    } else {
      this._writeLocal('regrip_profile', data);
    }
  },

  // ── Sessions ──
  async getSessions() {
    if (this._backend === 'rest') {
      const data = await this._fetch('/api/sessions');
      if (Array.isArray(data)) { this._writeLocal('regrip_sessions', data); return data; }
      return this._readLocal('regrip_sessions', []);   // fallback to mirror
    }
    return this._readLocal('regrip_sessions', []);
  },

  async saveSession(data) {
    if (this._backend === 'rest') {
      const res = await this._fetch('/api/sessions', { method: 'POST', body: data });
      if (res === null) {
        console.warn('[DataService] saveSession REST 실패 — 로컬에 저장합니다.');
        const sessions = this._readLocal('regrip_sessions', []);
        sessions.unshift({ ...data, id: data.id || Date.now() });
        this._writeLocal('regrip_sessions', sessions);
      }
    } else {
      const sessions = this._readLocal('regrip_sessions', []);
      sessions.unshift({ ...data, id: Date.now() });   // local mode id = Date.now()
      this._writeLocal('regrip_sessions', sessions);
    }
  },

  // ── Settings ──
  getSettingsSync() {
    return this._readLocal('regrip_settings', {});   // localStorage mirror
  },

  async getSettings() {
    if (this._backend === 'rest') {
      const data = await this._fetch('/api/settings');
      if (data) { this._writeLocal('regrip_settings', data); return data; }
      return this.getSettingsSync();
    }
    return this.getSettingsSync();
  },

  async saveSettings(data) {
    if (this._backend === 'rest') {
      const res = await this._fetch('/api/settings', { method: 'PUT', body: data });
      if (res === null) console.warn('[DataService] saveSettings REST 실패 — 로컬에 저장합니다.');
      this._writeLocal('regrip_settings', data);
    } else {
      this._writeLocal('regrip_settings', data);
    }
  },

  // ── Calibration ──
  async getCalibration() {
    if (this._backend === 'rest') {
      const data = await this._fetch('/api/calibration');
      if (data) { this._writeLocal('regrip_calibration', data); return data; }
      return this._readLocal('regrip_calibration', null);
    }
    return this._readLocal('regrip_calibration', null);
  },

  async saveCalibration(data) {
    if (this._backend === 'rest') {
      const res = await this._fetch('/api/calibration', { method: 'PUT', body: data });
      if (res === null) console.warn('[DataService] saveCalibration REST 실패 — 로컬에 저장합니다.');
      this._writeLocal('regrip_calibration', data);
    } else {
      this._writeLocal('regrip_calibration', data);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SENSOR SERVICE — simulation now, WebSocket / Serial later
//
// ESP32 integration (wireless-first — see docs/backend/04-sensor-data-policy.md ADR-04-0):
//   1. ESP32 runs a WebSocket server on the local network (port 8080)
//   2. Sends JSON: { "force": 73.5, "timestamp": 1717648200000 }
//   3. Call: SensorService.connect('ws://<esp32-ip>:8080')
//   (BLE / Web Serial are future transport adapters; wired USB is the fallback.)
//
// Status machine: 'simulation' | 'connecting' | 'connected' | 'disconnected'
//   connect()  → 'connecting'  (onopen → 'connected')
//   onclose    → 'disconnected' (stays while reconnect is pending)
//   disconnect()→ 'simulation'
// ═══════════════════════════════════════════════════════════════════════════════
const SensorService = {
  _ws: null,
  _mode: 'simulation',   // 'simulation' | 'websocket'
  _force: 0,
  _callbacks: [],
  _reconnectTimer: null,
  _wsUrl: null,
  _status: 'simulation',
  _statusCallbacks: [],
  _cal: null,            // { baseline0, baseline100 } — applied to real (onmessage) force only

  // ── Status machine ──
  getStatus() { return this._status; },
  onStatusChange(cb)  { if (typeof cb === 'function') this._statusCallbacks.push(cb); },
  offStatusChange(cb) { this._statusCallbacks = this._statusCallbacks.filter(c => c !== cb); },
  _emitStatus() { this._statusCallbacks.forEach(cb => { try { cb(this._status); } catch {} }); },
  _setStatus(s) { this._status = s; this._emitStatus(); },

  // ── Calibration ──
  setCalibration({ baseline0, baseline100 } = {}) {
    if (typeof baseline0 !== 'number' || typeof baseline100 !== 'number' || (baseline100 - baseline0) <= 0) {
      console.warn('[SensorService] 잘못된 캘리브레이션 값(범위 0 이하) — 무시합니다.', { baseline0, baseline100 });
      return;
    }
    this._cal = { baseline0, baseline100 };
  },

  async loadCalibration() {
    try {
      const cal = await DataService.getCalibration();
      if (cal && typeof cal.baseline0 === 'number' && typeof cal.baseline100 === 'number') {
        this.setCalibration(cal);
      }
    } catch (e) {
      console.warn('[SensorService] loadCalibration 실패:', e && e.message);
    }
  },

  // Normalize a raw sensor reading into a 0–100 logical value using calibration.
  _normalize(raw) {
    let v = raw;
    if (this._cal) {
      const { baseline0, baseline100 } = this._cal;
      v = (raw - baseline0) / (baseline100 - baseline0) * 100;
    }
    return Math.max(0, Math.min(100, v));
  },

  // ── Connection ──
  connect(wsUrl) {
    this._wsUrl = wsUrl;
    this._mode = 'websocket';
    this._setStatus('connecting');

    try {
      this._ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[SensorService] WebSocket 생성 실패:', e && e.message);
      this._setStatus('disconnected');
      return;
    }

    this._ws.onopen = () => {
      console.log('[SensorService] Connected to', wsUrl);
      clearTimeout(this._reconnectTimer);
      this._setStatus('connected');
    };

    this._ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.force === 'number') {
          this._force = this._normalize(data.force);   // calibration applies to real sensor data
          this._callbacks.forEach(cb => cb(this._force));
        }
      } catch {}
    };

    this._ws.onerror = () => {
      // NOTE: do NOT flip _mode to 'simulation' here — keeping _mode === 'websocket'
      // lets onclose schedule the reconnect (bug fix).
      console.warn('[SensorService] WebSocket error');
    };

    this._ws.onclose = () => {
      this._setStatus('disconnected');
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
    this._setStatus('simulation');
  },

  onForceUpdate(cb)    { this._callbacks.push(cb); },
  offForceUpdate(cb)   { this._callbacks = this._callbacks.filter(c => c !== cb); },
  getForce()           { return this._force; },
  getMode()            { return this._mode; },

  // Called by game loops when in simulation mode.
  // Calibration is NOT applied here — the value is already a logical 0–100.
  setSimulatedForce(v) {
    if (this._mode === 'simulation') {
      this._force = Math.max(0, Math.min(100, v));
      this._callbacks.forEach(cb => cb(this._force));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// GAME DEFINITIONS & SESSION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const GAME_DEFS = {
  balloon: { label: '풍선 게임',   icon: 'sports_esports', starThresholds: [5, 10] },
  crane:   { label: '크레인 게임', icon: 'sports_esports', starThresholds: [4, 8]  },
};

// Icons for legacy (pre-schema-2) exercise-labelled sessions.
const LEGACY_EXERCISE_ICONS = {
  '완전 그립 훈련': 'fitness_center',
  '핀치 그립 훈련': 'pinch',
  '측면 그립 훈련': 'pan_tool',
  '손가락 펴기':   'back_hand',
};

// Resolve a session's game id from an explicit field or its legacy label.
function gameIdOf(s) {
  if (!s) return null;
  return s.gameId || (s.label === '풍선 게임' ? 'balloon' : s.label === '크레인 게임' ? 'crane' : null);
}

// Stars (1–3) for a game score using GAME_DEFS thresholds [twoStar, threeStar].
function starsForScore(gameId, score) {
  const def = GAME_DEFS[gameId];
  if (!def) return 1;
  const [t2, t3] = def.starThresholds;
  return score >= t3 ? 3 : score >= t2 ? 2 : 1;
}

// Material icon for a session: GAME_DEFS → LEGACY → default 'exercise'.
function iconForSession(s) {
  const gid = gameIdOf(s);
  if (gid && GAME_DEFS[gid]) return GAME_DEFS[gid].icon;
  if (s && s.label && LEGACY_EXERCISE_ICONS[s.label]) return LEGACY_EXERCISE_ICONS[s.label];
  return 'exercise';
}

// Standard mulberry32 seeded PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-set detail rows. Uses session.setDetails when present; otherwise derives
// deterministic rows from mulberry32(session.id). Value ranges mirror the original
// history.html generateSetData(): force = clamp(round(avgForce ± 10), 10, 100),
// reps = 6–10, holdSecs = 2.0–6.0.
function deriveSetDetails(session) {
  if (session && Array.isArray(session.setDetails) && session.setDetails.length) {
    return session.setDetails;
  }
  const rand = mulberry32((session && session.id) || 1);
  const n = (session && session.sets) || 0;
  const avg = (session && session.avgForce) || 50;
  const out = [];
  for (let i = 0; i < n; i++) {
    const variation = (rand() - 0.5) * 20;
    const force = Math.min(100, Math.max(10, Math.round(avg + variation)));
    const reps = 6 + Math.floor(rand() * 5);
    const holdSecs = +(2 + rand() * 4).toFixed(1);
    out.push({ setNum: i + 1, reps, holdSecs, force });
  }
  return out;
}

// ── Date helpers (calendar-day math) ──
const DAY_MS = 86400000;
function dayNum(dateLike) {
  const d = new Date(dateLike);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / DAY_MS);
}
// Longest run of consecutive calendar days that contain a session (order-independent).
function maxConsecutiveDays(sessions) {
  if (!sessions || !sessions.length) return 0;
  const days = [...new Set(sessions.map(s => dayNum(s.date)))].sort((a, b) => a - b);
  let max = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i] === days[i - 1] + 1) { run++; if (run > max) max = run; }
    else run = 1;
  }
  return max;
}

function formatKoreanDate(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// Rarity → colors (reused from achievements.html vocabulary).
const RARITY_STYLE = {
  '일반': { color: '#0284C7', bg: '#E0F2FE' },
  '희귀': { color: '#9333EA', bg: '#F3E8FF' },
  '에픽': { color: '#CA8A04', bg: '#FEF9C3' },
  '전설': { color: '#DC2626', bg: '#FEE2E2' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// GAMIFICATION ENGINE — single source of truth for XP, levels, tiers, achievements
// ═══════════════════════════════════════════════════════════════════════════════
const GamificationEngine = {
  // Final formulas (documented per brief because the level.html copy blends several rules):
  //   xpForSession(s) = min(sessionBase + sets*perScoreUnit, sessionCap) + starBonus
  //       starBonus = stars===3 ? threeStarBonus : stars===2 ? twoStarBonus : 0   (added AFTER the cap)
  //   totalXp (leveling) = Σ xpForSession + (streak >= 7 ? streak7Bonus : 0) + Σ earned achievement xp
  //       → invariant: totalXp === Σ xpEvents[].xp, so the XP feed always sums to the total.
  //   weeklyXp / todayXp are windowed sums over xpEvents (same invariant, same feed).
  //   Worked example: sets 10, stars 3 → min(50+20,150)=70, +50 = 120, +100(first_pop) +150(three_star) = 370.
  XP_RULES: { sessionBase: 50, perScoreUnit: 2, sessionCap: 150, twoStarBonus: 20, threeStarBonus: 50, streak7Bonus: 200 },

  // Ported from level.html:325-332 (ranges expanded to numeric min/max).
  TIERS: [
    { name: '입문자', min: 1,  max: 10,  range: 'Lv. 1 ~ 10',   icon: 'emoji_nature',         color: '#10B981', bg: '#DCFCE7' },
    { name: '초심자', min: 11, max: 20,  range: 'Lv. 11 ~ 20',  icon: 'eco',                  color: '#0284C7', bg: '#E0F2FE' },
    { name: '중급자', min: 21, max: 40,  range: 'Lv. 21 ~ 40',  icon: 'bolt',                 color: '#9333EA', bg: '#F3E8FF' },
    { name: '숙련자', min: 41, max: 60,  range: 'Lv. 41 ~ 60',  icon: 'local_fire_department', color: '#CA8A04', bg: '#FEF9C3' },
    { name: '전문가', min: 61, max: 80,  range: 'Lv. 61 ~ 80',  icon: 'diamond',              color: '#DC2626', bg: '#FEE2E2' },
    { name: '마스터', min: 81, max: 100, range: 'Lv. 81 ~ 100', icon: 'workspace_premium',    color: '#994626', bg: '#FFE9E3' },
  ],

  // Measurable achievements. `measure(sessions)` returns the current progress count;
  // earned when it reaches `goal`. earnedDate = date of the session at which measure first hit goal.
  ACHIEVEMENTS: [
    {
      id: 'first_pop', title: '첫 풍선', icon: 'celebration',
      desc: '풍선 게임에서 첫 세트를 완료했습니다.', condition: '풍선 게임 1세트 이상 완료',
      category: '게임 플레이', rarity: '일반', xp: 100, goal: 1,
      measure: (sessions) => sessions.filter(s => gameIdOf(s) === 'balloon' && (s.sets || 0) >= 1).length,
    },
    {
      id: 'first_capsule', title: '첫 번째 캡슐', icon: 'redeem',
      desc: '크레인 게임에서 첫 캡슐을 수집했습니다.', condition: '크레인 게임 1세트 이상 완료',
      category: '게임 플레이', rarity: '일반', xp: 100, goal: 1,
      measure: (sessions) => sessions.filter(s => gameIdOf(s) === 'crane' && (s.sets || 0) >= 1).length,
    },
    {
      id: 'three_star', title: '퍼펙트 훈련', icon: 'star',
      desc: '한 세션에서 별 3개를 획득했습니다.', condition: '별 3개 세션 달성',
      category: '게임 플레이', rarity: '일반', xp: 150, goal: 1,
      measure: (sessions) => sessions.filter(s => s.stars === 3).length,
    },
    {
      id: 'strong_grip', title: '강철 악력', icon: 'fitness_center',
      desc: '최대 악력 80% 이상을 5회 달성했습니다.', condition: '최대 악력 80% 이상 5회 누적',
      category: '악력 훈련', rarity: '희귀', xp: 200, goal: 5,
      measure: (sessions) => sessions.filter(s => (s.maxForce || 0) >= 80).length,
    },
    {
      id: 'consistency_king', title: '꾸준함의 왕', icon: 'local_fire_department',
      desc: '7일 연속으로 훈련했습니다.', condition: '7일 연속 훈련',
      category: '지속성', rarity: '에픽', xp: 300, goal: 7,
      measure: (sessions) => maxConsecutiveDays(sessions),
    },
    {
      id: 'halfway_goal', title: '캡슐 수집가', icon: 'inventory_2',
      desc: '크레인 게임에서 누적 캡슐 500개를 수집했습니다.', condition: '누적 캡슐 500개 수집',
      category: '수집', rarity: '전설', xp: 500, goal: 500,
      measure: (sessions) => sessions
        .filter(s => gameIdOf(s) === 'crane')
        .reduce((n, s) => n + (s.sets || 0), 0),
    },
  ],

  xpForSession(s) {
    const sets = (s && s.sets) || 0;
    const base = Math.min(this.XP_RULES.sessionBase + sets * this.XP_RULES.perScoreUnit, this.XP_RULES.sessionCap);
    const stars = (s && s.stars) || 0;
    const bonus = stars === 3 ? this.XP_RULES.threeStarBonus : stars === 2 ? this.XP_RULES.twoStarBonus : 0;
    return base + bonus;
  },

  // XP required to advance from `level` to `level + 1`.
  xpToNext(level) {
    return 100 + (Math.max(1, level) - 1) * 25;
  },

  // Resolve total leveling XP into a level (1–100) and progress into the current level.
  // progressPct is exact arithmetic (round only for display).
  levelFromXp(totalXp) {
    totalXp = Math.max(0, Math.floor(Number(totalXp) || 0));
    let level = 1;
    let remaining = totalXp;
    while (level < 100) {
      const need = this.xpToNext(level);
      if (remaining >= need) { remaining -= need; level++; }
      else break;
    }
    if (level >= 100) {
      return { level: 100, xpIntoLevel: remaining, xpForNext: 0, progressPct: 100 };
    }
    const xpForNext = this.xpToNext(level);
    const progressPct = xpForNext > 0 ? (remaining / xpForNext) * 100 : 0;
    return { level, xpIntoLevel: remaining, xpForNext, progressPct };
  },

  tierForLevel(level) {
    let idx = this.TIERS.findIndex(t => level >= t.min && level <= t.max);
    if (idx === -1) idx = level < 1 ? 0 : this.TIERS.length - 1;
    return { tier: this.TIERS[idx], tierIndex: idx };
  },

  // Current streak: consecutive calendar days ending today (or yesterday), counted backwards.
  computeStreak(sessions) {
    if (!sessions || !sessions.length) return 0;
    const days = new Set(sessions.map(s => dayNum(s.date)));
    const today = dayNum(new Date());
    let cursor;
    if (days.has(today)) cursor = today;
    else if (days.has(today - 1)) cursor = today - 1;
    else return 0;
    let streak = 0;
    while (days.has(cursor)) { streak++; cursor--; }
    return streak;
  },

  computeStats(sessions, profile) {
    sessions = Array.isArray(sessions) ? sessions : [];
    profile = profile || {};

    const totalSessions = sessions.length;
    const chrono = [...sessions].sort((a, b) => new Date(a.date) - new Date(b.date));
    const recent = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));

    // ── Streak & session XP ──
    const streak = this.computeStreak(sessions);
    const sessionXp = sessions.reduce((sum, s) => sum + this.xpForSession(s), 0);
    const streakBonus = streak >= 7 ? this.XP_RULES.streak7Bonus : 0;

    // ── Aggregates ──
    const maxForce = sessions.reduce((m, s) => Math.max(m, s.maxForce || 0), 0);
    const avgSets = totalSessions
      ? Math.round((sessions.reduce((a, s) => a + (s.sets || 0), 0) / totalSessions) * 10) / 10
      : 0;

    // ── Weekly windows (calendar days) ──
    const todayN = dayNum(new Date());
    const inThisWeek = (s) => { const n = dayNum(s.date); return n >= todayN - 6 && n <= todayN; };
    const inPrevWeek = (s) => { const n = dayNum(s.date); return n >= todayN - 13 && n <= todayN - 7; };
    const thisWeek = sessions.filter(inThisWeek);
    const prevWeek = sessions.filter(inPrevWeek);

    const weeklyDoneDays = new Set(thisWeek.map(s => dayNum(s.date))).size;
    const weeklyGoalDays = Number(profile.goalDays) || 5;

    const meanForce = (arr) => arr.length ? arr.reduce((a, s) => a + (s.avgForce || 0), 0) / arr.length : null;
    const twForce = meanForce(thisWeek);
    const pwForce = meanForce(prevWeek);
    const weeklyForceDeltaPct = (twForce != null && pwForce != null && pwForce !== 0)
      ? ((twForce - pwForce) / pwForce) * 100
      : null;   // null when either week lacks data

    // ── Achievements ──
    const achievements = this.ACHIEVEMENTS.map(def => {
      const current = def.measure(chrono);
      const goal = def.goal;
      const earned = current >= goal;
      let earnedDateRaw = null;
      if (earned) {
        for (let i = 0; i < chrono.length; i++) {
          if (def.measure(chrono.slice(0, i + 1)) >= goal) { earnedDateRaw = chrono[i].date; break; }
        }
      }
      const shown = Math.min(current, goal);
      const progressPct = goal > 0 ? Math.max(0, Math.min(100, (shown / goal) * 100)) : 0;
      return {
        ...def,
        earned,
        earnedDateRaw,
        earnedDate: earnedDateRaw ? formatKoreanDate(earnedDateRaw) : null,
        progressPct,
        progressLabel: `${shown} / ${goal}`,
      };
    });
    const earnedCount = achievements.filter(a => a.earned).length;
    const totalAchievements = achievements.length;
    const achievementXp = achievements.filter(a => a.earned).reduce((sum, a) => sum + a.xp, 0);

    // ── Total XP & level (achievement rewards count toward leveling) ──
    const totalXp = sessionXp + streakBonus + achievementXp;
    const lvl = this.levelFromXp(totalXp);
    const { tier, tierIndex } = this.tierForLevel(lvl.level);

    // ── XP events feed (sessions + bonuses + achievements), newest first ──
    const xpEvents = [];
    for (const s of sessions) {
      const gid = gameIdOf(s);
      const def = gid ? GAME_DEFS[gid] : null;
      const baseXp = Math.min(this.XP_RULES.sessionBase + (s.sets || 0) * this.XP_RULES.perScoreUnit, this.XP_RULES.sessionCap);
      xpEvents.push({ date: s.date, label: `${def ? def.label : (s.label || '훈련')} 완료`, xp: baseXp, icon: iconForSession(s), color: '#994626' });
      if (s.stars === 3)      xpEvents.push({ date: s.date, label: '별 3개 보너스', xp: this.XP_RULES.threeStarBonus, icon: 'star', color: '#CA8A04' });
      else if (s.stars === 2) xpEvents.push({ date: s.date, label: '별 2개 보너스', xp: this.XP_RULES.twoStarBonus, icon: 'star', color: '#CA8A04' });
    }
    if (streak >= 7) {
      xpEvents.push({ date: new Date().toISOString(), label: '7일 연속 훈련', xp: this.XP_RULES.streak7Bonus, icon: 'local_fire_department', color: '#DC2626' });
    }
    for (const a of achievements) {
      if (a.earned && a.earnedDateRaw) {
        xpEvents.push({ date: a.earnedDateRaw, label: a.title, xp: a.xp, icon: a.icon, color: (RARITY_STYLE[a.rarity] || {}).color || '#994626' });
      }
    }
    xpEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Windowed XP sums over the same feed (keeps 총/이번 주/오늘 mutually consistent).
    const weeklyXp = xpEvents.filter(e => { const n = dayNum(e.date); return n >= todayN - 6 && n <= todayN; })
      .reduce((sum, e) => sum + e.xp, 0);
    const todayXp = xpEvents.filter(e => dayNum(e.date) === todayN)
      .reduce((sum, e) => sum + e.xp, 0);

    const recentSessions = recent.slice(0, 10).map(s => ({ ...s, gameId: gameIdOf(s), icon: iconForSession(s) }));

    return {
      totalXp,
      level: lvl.level,
      tier,
      tierIndex,
      xpIntoLevel: lvl.xpIntoLevel,
      xpForNext: lvl.xpForNext,
      progressPct: lvl.progressPct,
      streak,
      totalSessions,
      maxForce,
      avgSets,
      weeklyDoneDays,
      weeklyGoalDays,
      weeklyForceDeltaPct,
      weeklyXp,
      todayXp,
      achievementXp,
      achievements,
      earnedCount,
      totalAchievements,
      xpEvents,
      recentSessions,
    };
  },

  async getStats() {
    return this.computeStats(await DataService.getSessions(), DataService.getProfileSync());
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SENSOR STATUS UI
// ═══════════════════════════════════════════════════════════════════════════════
const SENSOR_STATUS_META = {
  simulation:   { label: '시뮬레이션 모드', color: '#D97706', bg: '#FEF3C7', icon: 'science'      },
  connecting:   { label: '연결 중…',        color: '#64748B', bg: '#F1F5F9', icon: 'sync'         },
  connected:    { label: '센서 연결됨',      color: '#15803D', bg: '#DCFCE7', icon: 'sensors'      },
  disconnected: { label: '연결 끊김',        color: '#DC2626', bg: '#FEE2E2', icon: 'sensors_off'  },
};

// Update the sidebar sensor badge (#nav-sensor-status) to reflect current status.
function renderSensorStatus() {
  const el = document.getElementById('nav-sensor-status');
  if (!el) return;
  const meta = SENSOR_STATUS_META[SensorService.getStatus()] || SENSOR_STATUS_META.simulation;
  el.style.background = meta.bg;
  el.innerHTML = `
    <span style="display:flex;align-items:center;gap:6px;">
      <span class="material-symbols-outlined" style="font-size:18px;color:${meta.color};font-variation-settings:'FILL' 1">${meta.icon}</span>
      ${meta.label}
    </span>
    <span style="width:8px;height:8px;border-radius:50%;background:${meta.color};display:inline-block;"></span>
  `;
}

// Bind a compact status badge (game headers / settings). Returns an unsubscribe fn.
function bindSensorBadge(el) {
  if (!el) return () => {};
  const render = () => {
    const meta = SENSOR_STATUS_META[SensorService.getStatus()] || SENSOR_STATUS_META.simulation;
    el.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${meta.color};display:inline-block;flex-shrink:0;"></span>
      <span style="color:${meta.color};font-weight:700;">${meta.label}</span>
    `;
  };
  render();
  SensorService.onStatusChange(render);
  return () => SensorService.offStatusChange(render);
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function prefersReducedMotion() {
  return (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    || (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-reduced-motion'));
}

// rAF count-up. Honors reduced motion (snaps to target instantly).
function animateCount(el, target, { suffix = '', duration = 800, decimals = 0 } = {}) {
  if (!el) return;
  target = Number(target) || 0;
  const fmt = (v) => (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v))) + suffix;
  if (prefersReducedMotion() || duration <= 0) { el.textContent = fmt(target); return; }
  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);   // easeOutCubic
    el.textContent = fmt(target * eased);
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = fmt(target);
  }
  requestAnimationFrame(frame);
}

// Inject a composed empty state into `el`.
function renderEmptyState(el, { icon = 'inbox', title = '', desc = '', ctaHref, ctaLabel, secondaryHref, secondaryLabel } = {}) {
  if (!el) return;
  const cta = (ctaHref && ctaLabel) ? `<a class="btn-retro btn-retro-primary" href="${ctaHref}">${ctaLabel}</a>` : '';
  const secondary = (secondaryHref && secondaryLabel) ? `<a class="btn-retro" href="${secondaryHref}">${secondaryLabel}</a>` : '';
  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon"><span class="material-symbols-outlined">${icon}</span></div>
      <h3 class="empty-state-title">${title}</h3>
      <p class="empty-state-desc">${desc}</p>
      ${(cta || secondary) ? `<div class="empty-state-actions">${cta}${secondary}</div>` : ''}
    </div>
  `;
}

// Retro confirm modal (replaces native confirm()). Escape / backdrop close, focus move + restore.
function openConfirmModal({ title = '', body = '', confirmLabel = '확인', cancelLabel = '취소', danger = false, onConfirm } = {}) {
  const prevFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'confirm-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="confirm-modal-card" role="document">
      <h2 class="confirm-modal-title">${title}</h2>
      <p class="confirm-modal-body">${body}</p>
      <div class="confirm-modal-actions">
        <button type="button" class="btn-retro confirm-cancel">${cancelLabel}</button>
        <button type="button" class="btn-retro ${danger ? 'btn-retro-danger' : 'btn-retro-primary'} confirm-ok">${confirmLabel}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  const close = () => {
    overlay.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };

  overlay.querySelector('.confirm-cancel').addEventListener('click', close);
  overlay.querySelector('.confirm-ok').addEventListener('click', () => {
    close();
    if (typeof onConfirm === 'function') onConfirm();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  const ok = overlay.querySelector('.confirm-ok');
  if (ok && typeof ok.focus === 'function') ok.focus();
  return close;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO SEEDING
// ═══════════════════════════════════════════════════════════════════════════════
// Populate 14 days of demo sessions (schema 2). No-op (returns false) if any session
// already exists. Deterministic via mulberry32 so demos are reproducible.
function seedDemoData() {
  let existing = [];
  try { existing = JSON.parse(localStorage.getItem('regrip_sessions')) || []; } catch {}
  if (existing.length > 0) return false;

  const now = Date.now();
  const rand = mulberry32(20260709);
  const sessions = [];
  for (let i = 0; i < 14; i++) {
    const gameId = i % 2 === 0 ? 'balloon' : 'crane';
    const def = GAME_DEFS[gameId];
    const id = now - i * DAY_MS;
    const sets = 4 + Math.floor(rand() * 9);          // 4–12
    const avgForce = 45 + Math.floor(rand() * 40);    // 45–84
    const maxForce = Math.min(100, avgForce + 8 + Math.floor(rand() * 20));
    const stars = starsForScore(gameId, sets);        // score == sets for these games
    const durationSec = 300 + Math.floor(rand() * 900);
    const durationMin = Math.round(durationSec / 60); // legacy consumers read minutes

    const setDetails = [];
    for (let j = 0; j < sets; j++) {
      const variation = (rand() - 0.5) * 20;
      const force = Math.min(100, Math.max(10, Math.round(avgForce + variation)));
      const reps = 6 + Math.floor(rand() * 5);
      const holdSecs = +(2 + rand() * 4).toFixed(1);
      setDetails.push({ setNum: j + 1, reps, holdSecs, force });
    }

    const session = {
      id,
      date: new Date(id).toISOString(),
      gameId,
      label: def.label,
      sets,
      avgForce,
      maxForce,
      stars,
      durationSec,
      durationMin,
      setDetails,
      demo: true,
      schema: 2,
    };
    if (gameId === 'crane') session.attempts = sets + 2 + Math.floor(rand() * 3);   // sets+2 … sets+4
    sessions.push(session);
  }
  localStorage.setItem('regrip_sessions', JSON.stringify(sessions));   // sessions[0] = today (newest first)
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE INIT
// ═══════════════════════════════════════════════════════════════════════════════
function initPage(activeKey) {
  injectNav(activeKey);
  injectFeedbackModal();

  // Reduced-motion preference from settings → root attribute (shared.css disables motion).
  try {
    const settings = DataService.getSettingsSync();
    if (settings && settings.reducedMotion) {
      document.documentElement.setAttribute('data-reduced-motion', '');
    }
  } catch {}

  // ?demo=1 seeds demo data (also triggerable from a settings button).
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') seedDemoData();
  } catch {}

  // Load sensor calibration (fire-and-forget).
  try { SensorService.loadCalibration(); } catch {}

  // Keep the sidebar sensor badge live.
  if (!initPage._sensorBound) {
    SensorService.onStatusChange(renderSensorStatus);
    initPage._sensorBound = true;
  }
  renderSensorStatus();
}

// ── Node interop (unit testing only; harmless in the browser) ──
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DataService, SensorService, GamificationEngine,
    GAME_DEFS, LEGACY_EXERCISE_ICONS, RARITY_STYLE, SENSOR_STATUS_META,
    gameIdOf, starsForScore, iconForSession, mulberry32, deriveSetDetails,
    maxConsecutiveDays, dayNum, formatKoreanDate,
  };
}
