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
  // Server profiles carry a relative avatarUrl — resolve it against the API origin.
  const avatarSrc  = profile.avatarBase64 || DataService.assetUrl(profile.avatarUrl) || DEFAULT_AVATAR;

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
// AUTH SERVICE — JWT access token (localStorage) + httpOnly refresh cookie
//
// Backend contract (docs/backend/02-api-spec §2, all camelCase, base = {apiBase}/api/v1):
//   POST /auth/signup  {email, password, profile:{name, birthDate?}, consents:{...true}}
//   POST /auth/login   {email, password}
//   POST /auth/refresh (no body — uses httpOnly cookie; requires credentials:'include')
//   POST /auth/logout
//   → {accessToken, expiresIn, user:{id,email,role}} + Set-Cookie: refresh_token (SameSite=Strict)
//
// The refresh token lives ONLY in an httpOnly cookie — JS never sees it. Because the
// cookie is SameSite=Strict, the frontend origin and the API origin must share a hostname
// (both `localhost` OR both `127.0.0.1`) for refresh to work. Ports may differ (same-site).
// localStorage keys: regrip_access_token, regrip_user.
// ═══════════════════════════════════════════════════════════════════════════════
const AuthService = {
  async signup({ email, password, name, birthDate } = {}) {
    const body = {
      email,
      password,
      profile: { name, ...(birthDate ? { birthDate } : {}) },
      // Both consents are required by the backend and fixed true here (login UI collects them).
      consents: { sensitiveData: true, sensitiveDataAt: new Date().toISOString(), termsOfService: true },
    };
    return this._authPost('/auth/signup', body);
  },

  async login(email, password) {
    return this._authPost('/auth/login', { email, password });
  },

  // Silent token renewal. Returns true on success (new accessToken stored), false otherwise.
  async refresh() {
    try {
      const res = await fetch(DataService._apiUrl('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !data.accessToken) return false;
      this._store(data);
      return true;
    } catch (e) {
      console.warn('[AuthService] refresh 실패:', e && e.message);
      return false;
    }
  },

  async logout() {
    try {
      await fetch(DataService._apiUrl('/auth/logout'), { method: 'POST', credentials: 'include' });
    } catch (e) {
      console.warn('[AuthService] logout 요청 실패(로컬 토큰은 삭제합니다):', e && e.message);
    }
    this._clearTokens();
  },

  getUser() {
    try { return JSON.parse(localStorage.getItem('regrip_user')); } catch { return null; }
  },
  isAuthenticated() { return !!this.getAccessToken(); },
  getAccessToken() {
    try { return localStorage.getItem('regrip_access_token') || null; } catch { return null; }
  },

  // ── internals ──
  // Returns { ok, data, message }. On success stores token + user; never throws.
  async _authPost(path, body) {
    try {
      const res = await fetch(DataService._apiUrl(path), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        const message = (data && data.error && data.error.message) || `요청 실패 (HTTP ${res.status})`;
        return { ok: false, data, message };
      }
      if (data && data.accessToken) this._store(data);
      return { ok: true, data, message: '' };
    } catch (e) {
      return { ok: false, data: null, message: '서버에 연결할 수 없습니다. 주소를 확인해 주세요.' };
    }
  },
  _store(data) {
    try {
      if (data.accessToken) localStorage.setItem('regrip_access_token', data.accessToken);
      if (data.user) localStorage.setItem('regrip_user', JSON.stringify(data.user));
    } catch (e) { console.warn('[AuthService] 토큰 저장 실패:', e && e.message); }
  },
  _clearTokens() {
    try {
      localStorage.removeItem('regrip_access_token');
      localStorage.removeItem('regrip_user');
    } catch {}
  },
};

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
  _authLostHandled: false,

  setBackend(type, baseUrl = '', headers = {}) {
    this._backend = type;
    this._baseUrl = String(baseUrl || '').replace(/\/+$/, '');   // strip trailing slash
    this._headers = { ...this._headers, ...headers };
  },

  isRest() { return this._backend === 'rest'; },

  // Build a full API URL: {baseUrl}/api/v1{path}. `path` is like '/users/me/sessions'.
  _apiUrl(path) {
    const base = (this._baseUrl || '').replace(/\/+$/, '');
    return base + '/api/v1' + path;
  },

  // Resolve a server-relative asset path (e.g. avatarUrl '/static/avatars/x.png') against the
  // API origin. The frontend is served from a different origin, so relative paths would 404.
  assetUrl(url) {
    if (!url) return url;
    if (/^(https?:|data:)/.test(url)) return url;
    const base = (this._baseUrl || '').replace(/\/+$/, '');
    return base + (url.startsWith('/') ? url : '/' + url);
  },

  // Point the app at a backend and persist it, so a reload restores REST mode (see bootstrap).
  connectServer(baseUrl) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    try { localStorage.setItem('regrip_api_base', base); } catch {}
    this.setBackend('rest', base);
  },

  // Return to local-only mode. Does not touch auth tokens (use AuthService.logout for that).
  disconnectServer() {
    try { localStorage.removeItem('regrip_api_base'); } catch {}
    this.setBackend('local', '');
  },

  // Called when a request is 401 and refresh could not recover the session.
  _onAuthLost() {
    if (this._authLostHandled) return;
    if (typeof location === 'undefined') return;
    const file = (location.pathname.split('/').pop() || 'index.html');
    if (file === 'login.html') return;
    this._authLostHandled = true;
    location.href = 'login.html?redirect=' + encodeURIComponent(file);
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
  // GET/PUT/POST against {apiBase}/api/v1{path}. Injects Bearer token + credentials.
  // On 401: tries AuthService.refresh() once, retries the request, else clears tokens
  // and routes to login (via _onAuthLost). Returns parsed JSON ({} for empty body) on
  // success, or null on any failure (callers fall back to their localStorage mirror).
  async _fetch(path, opts = {}, _retry = true) {
    try {
      const headers = { ...this._headers, ...(opts.headers || {}) };
      if (!headers['Authorization']) {
        const tok = AuthService.getAccessToken();
        if (tok) headers['Authorization'] = 'Bearer ' + tok;
      }
      let body = opts.body;
      if (body !== undefined && typeof body !== 'string') {
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
      }
      const res = await fetch(this._apiUrl(path), { ...opts, headers, body, credentials: 'include' });

      if (res.status === 401 && _retry) {
        const recovered = await AuthService.refresh();
        if (recovered) return this._fetch(path, opts, false);   // retry once with fresh token
        AuthService._clearTokens();
        this._onAuthLost();
        return null;
      }

      if (!res.ok) {
        if (!(opts.silent404 && res.status === 404)) {   // 404 can be a normal state (e.g. no calibration yet)
          let msg = '';
          try { const j = await res.json(); msg = j && j.error && j.error.message; } catch {}
          console.warn(`[DataService] ${opts.method || 'GET'} ${path} → HTTP ${res.status}${msg ? ' — ' + msg : ''}`);
        }
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
      const data = await this._fetch('/users/me/profile');
      if (data) { this._writeLocal('regrip_profile', data); return data; }  // refresh cache mirror (incl. avatarUrl)
      return this.getProfileSync();                                         // fallback to mirror
    }
    return this.getProfileSync();
  },

  async saveProfile(data) {
    if (this._backend === 'rest') {
      // Server accepts birthDate (not age) + partial updates. Strip age, cast goal fields,
      // drop empty strings, and forward avatarBase64 only when it is a real data URL.
      const payload = {};
      const copyIf = (k, v) => { if (v !== undefined && v !== null && v !== '') payload[k] = v; };
      copyIf('name', data.name);
      copyIf('birthDate', data.birthDate);
      copyIf('gender', data.gender);
      copyIf('phone', data.phone);
      copyIf('hand', data.hand);
      copyIf('injuryType', data.injuryType);
      copyIf('treatmentStart', data.treatmentStart);
      copyIf('doctorName', data.doctorName);
      if (data.goalForce !== undefined && data.goalForce !== null && data.goalForce !== '') payload.goalForce = Number(data.goalForce);
      if (data.goalDays !== undefined && data.goalDays !== null && data.goalDays !== '') payload.goalDays = Number(data.goalDays);
      if (typeof data.avatarBase64 === 'string' && data.avatarBase64.startsWith('data:')) payload.avatarBase64 = data.avatarBase64;

      const res = await this._fetch('/users/me/profile', { method: 'PUT', body: payload });
      if (res) {
        this._writeLocal('regrip_profile', res);   // mirror the authoritative response (avatarUrl now resolved)
        return res;
      }
      console.warn('[DataService] saveProfile REST 실패 — 로컬 미러에 저장합니다.');
      this._writeLocal('regrip_profile', { ...this.getProfileSync(), ...data });
      return null;
    }
    this._writeLocal('regrip_profile', data);
  },

  // Map a server SessionSummary → the frontend v2 session shape used across pages.
  _sessionFromServer(s) {
    const et = s.exerciseType || '';
    return {
      id: s.id,
      clientSessionId: s.clientSessionId,
      date: s.date,
      gameId: et.startsWith('game_') ? et.slice(5) : null,
      label: s.label,
      durationMin: s.durationMin,
      sets: s.sets,
      avgForce: s.avgForce,
      maxForce: s.maxForce,
      stars: s.stars,
      schema: 2,
      fromServer: true,
    };
  },

  // ── Sessions ──
  async getSessions() {
    if (this._backend === 'rest') {
      const res = await this._fetch('/users/me/sessions?limit=100');
      if (res && Array.isArray(res.data)) {
        const mapped = res.data.map(s => this._sessionFromServer(s));
        this._writeLocal('regrip_sessions', mapped);
        return mapped;
      }
      return this._readLocal('regrip_sessions', []);   // fallback to mirror
    }
    return this._readLocal('regrip_sessions', []);
  },

  // Prepend a session object to the local mirror (newest first).
  _mirrorSession(session) {
    const sessions = this._readLocal('regrip_sessions', []);
    sessions.unshift(session);
    this._writeLocal('regrip_sessions', sessions);
  },

  // Convert a frontend v2 session → the backend POST payload.
  _sessionToPayload(data, clientSessionId, exerciseType) {
    const seen = new Set();
    const sets = (data.setDetails || []).reduce((acc, d) => {
      if (seen.has(d.setNum)) return acc;   // defend against duplicate setIndex (server rejects it)
      seen.add(d.setNum);
      acc.push({
        setIndex: d.setNum,
        reps: d.reps != null ? d.reps : null,
        avgForce: d.force,
        peakForce: d.force,
        holdSec: Math.round(d.holdSecs || 0),   // server requires integer holdSec
      });
      return acc;
    }, []);
    return {
      clientSessionId,
      exerciseType,
      startedAt: data.date,
      durationSec: data.durationSec != null ? data.durationSec : (data.durationMin || 1) * 60,
      score: data.sets,
      avgForce: data.avgForce,
      maxForce: data.maxForce,
      attempts: data.attempts != null ? data.attempts : data.sets,
      ...(data.difficulty ? { difficulty: data.difficulty } : {}),
      ...(data.handUsed ? { handUsed: data.handUsed } : {}),
      ...(sets.length ? { sets } : {}),
    };
  },

  async saveSession(data) {
    if (this._backend === 'rest') {
      // Idempotency: reuse/generate a clientSessionId and mirror the session locally FIRST so a
      // retry (offline queue) re-sends the SAME key and the server dedupes it.
      const clientSessionId = data.clientSessionId || _uuid();
      data.clientSessionId = clientSessionId;
      this._mirrorSession({ ...data, id: data.id || clientSessionId, clientSessionId });

      const gid = gameIdOf(data);
      if (!gid) {
        // Legacy demo-labelled session with no resolvable gameId → not in the server enum.
        console.warn('[DataService] saveSession: exerciseType 를 유도할 수 없어 서버 전송을 생략합니다(로컬 저장만).', data.label);
        return undefined;
      }
      const payload = this._sessionToPayload(data, clientSessionId, 'game_' + gid);
      const res = await this._fetch('/users/me/sessions', { method: 'POST', body: payload });
      if (res === null) {
        console.warn('[DataService] saveSession REST 실패 — 로컬 미러에 저장되어 있습니다(오프라인 내성).');
        return undefined;
      }
      return res;   // {session, xpAwarded, totalXp, level, levelUp, unlockedAchievements}
    }
    const sessions = this._readLocal('regrip_sessions', []);
    sessions.unshift({ ...data, id: Date.now() });   // local mode id = Date.now()
    this._writeLocal('regrip_sessions', sessions);
    return undefined;
  },

  // ── Settings ──
  getSettingsSync() {
    return this._readLocal('regrip_settings', {});   // localStorage mirror
  },

  async getSettings() {
    const local = this.getSettingsSync();
    if (this._backend === 'rest') {
      const data = await this._fetch('/users/me/settings');
      if (data) {
        // Server fields override shared keys; local-only fields (reducedMotion, sensorName)
        // are always kept from localStorage (the server has no reducedMotion).
        const merged = { ...local, ...data, reducedMotion: local.reducedMotion };
        this._writeLocal('regrip_settings', merged);
        return merged;
      }
      return local;
    }
    return local;
  },

  async saveSettings(data) {
    // Local-only fields (reducedMotion, sensorName, …) always persist to the mirror.
    this._writeLocal('regrip_settings', data);
    if (this._backend === 'rest') {
      const payload = {};
      const keep = ['hand', 'difficulty', 'restSeconds', 'reminderEnabled', 'reminderTime', 'sessionSummaryEnabled', 'timezone'];
      keep.forEach(k => { if (data[k] !== undefined) payload[k] = data[k]; });
      if (!payload.timezone) {
        try { payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
      }
      const res = await this._fetch('/users/me/settings', { method: 'PUT', body: payload });
      if (res === null) console.warn('[DataService] saveSettings REST 실패 — 로컬 미러에 저장했습니다.');
    }
  },

  // ── Calibration ──
  async getCalibration() {
    if (this._backend === 'rest') {
      const data = await this._fetch('/users/me/calibrations/latest', { silent404: true });
      if (data && data.baselineRaw0 != null) {
        const cal = { baseline0: data.baselineRaw0, baseline100: data.baselineRaw100, date: data.calibratedAt };
        this._writeLocal('regrip_calibration', cal);
        return cal;
      }
      // No calibration yet is a normal state: the server answers 204 (empty body → {}), and an
      // older server may answer 404 (silenced above). Either way we fall back to the local mirror.
      return this._readLocal('regrip_calibration', null);
    }
    return this._readLocal('regrip_calibration', null);
  },

  async saveCalibration(data) {
    if (this._backend === 'rest') {
      const payload = { baselineRaw0: data.baseline0, baselineRaw100: data.baseline100 };
      const res = await this._fetch('/users/me/calibrations', { method: 'POST', body: payload });
      if (res === null) console.warn('[DataService] saveCalibration REST 실패 — 로컬에 저장합니다.');
      this._writeLocal('regrip_calibration', { baseline0: data.baseline0, baseline100: data.baseline100, date: data.date });
    } else {
      this._writeLocal('regrip_calibration', data);
    }
  },
};

// UUID v4 for clientSessionId (idempotency key). Uses crypto.randomUUID when available
// (secure contexts incl. localhost); falls back to a Math.random-based v4 otherwise.
function _uuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Bootstrap: restore REST mode across reloads ──
// If a backend was previously connected, re-enter REST mode. The access token is injected
// per-request in _fetch (read fresh from localStorage), so refresh rotation keeps working.
(function bootstrapDataService() {
  try {
    const base = localStorage.getItem('regrip_api_base');
    if (base) DataService.setBackend('rest', base);
  } catch {}
})();

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

// Derive a 32-bit unsigned seed from a session id.
//   - Numeric id (local mode, Date.now()): `id >>> 0` — identical to mulberry32's own
//     truncation, so local behavior is byte-for-byte unchanged.
//   - String id (REST mode, UUID): FNV-1a 32-bit hash, so distinct UUIDs seed distinct
//     PRNG streams (fixes the `'…' >>> 0 === 0` collapse where every session looked alike).
// Deterministic: the same id always yields the same seed.
function _seedFrom(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return id >>> 0;
  const s = String(id == null ? '' : id);
  let h = 0x811c9dc5;                    // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);        // FNV prime
  }
  return h >>> 0;
}

// Per-set detail rows. Uses session.setDetails when present; otherwise derives
// deterministic rows from mulberry32(session.id). Value ranges mirror the original
// history.html generateSetData(): force = clamp(round(avgForce ± 10), 10, 100),
// reps = 6–10, holdSecs = 2.0–6.0.
function deriveSetDetails(session) {
  if (session && Array.isArray(session.setDetails) && session.setDetails.length) {
    return session.setDetails;
  }
  const rand = mulberry32(_seedFrom((session && session.id) || 1));
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
    if (DataService.isRest()) return this._statsFromServer();
    return this.computeStats(await DataService.getSessions(), DataService.getProfileSync());
  },

  // REST mode: the server is the source of truth for XP / level / streak / achievements.
  // Returns the SAME shape (keys) as computeStats so all six pages render unchanged.
  // If any server fetch fails, falls back to local computation (warns once).
  _serverFallbackWarned: false,
  async _statsFromServer() {
    const profile = DataService.getProfileSync();
    const [statsRes, achRes, xpRes, sessions] = await Promise.all([
      DataService._fetch('/users/me/stats'),
      DataService._fetch('/users/me/achievements'),
      DataService._fetch('/users/me/xp-events?limit=100'),
      DataService.getSessions(),
    ]);

    if (!statsRes || !achRes || !Array.isArray(achRes.data) || !xpRes || !Array.isArray(xpRes.data)) {
      if (!this._serverFallbackWarned) {
        console.warn('[GamificationEngine] 서버 통계 조회 실패 — 로컬 계산으로 폴백합니다.');
        this._serverFallbackWarned = true;
      }
      return this.computeStats(Array.isArray(sessions) ? sessions : [], profile);
    }

    const sess = Array.isArray(sessions) ? sessions : [];

    // ── Server-authoritative scalars ──
    const totalXp = Number(statsRes.totalXp) || 0;
    const level = Number(statsRes.level) || 1;
    const streak = Number(statsRes.currentStreak) || 0;
    const totalSessions = Number(statsRes.totalSessions) || 0;
    const maxForce = statsRes.bestMaxForce != null ? statsRes.bestMaxForce : 0;

    // Level progress + tier are DERIVED from XP/level (same formula as server → consistent);
    // deriving the tier from the level is more robust than mapping the server's slug.
    const lvl = this.levelFromXp(totalXp);
    const { tier, tierIndex } = this.tierForLevel(level);

    // ── Achievements: server progress/unlock + local icon/condition lookup (server has no icon) ──
    const localById = {};
    this.ACHIEVEMENTS.forEach(d => { localById[d.id] = d; });
    const achievements = achRes.data.map(a => {
      const def = localById[a.id] || {};
      const target = a.target || 0;
      const progress = a.progress || 0;
      return {
        id: a.id,
        title: a.title,
        desc: a.description,
        condition: def.condition || '',
        category: a.category,
        rarity: a.rarity,
        xp: a.rewardXp,
        goal: target,
        target,
        icon: def.icon || 'workspace_premium',
        earned: !!a.unlockedAt,
        earnedDateRaw: a.unlockedAt || null,
        earnedDate: a.unlockedAt ? formatKoreanDate(a.unlockedAt) : null,
        progressPct: target > 0 ? Math.min(100, (progress / target) * 100) : 0,
        progressLabel: a.progressLabel != null ? a.progressLabel : `${Math.min(progress, target)} / ${target}`,
      };
    });
    const earnedCount = achievements.filter(a => a.earned).length;
    const totalAchievements = achievements.length;
    const achievementXp = achievements.filter(a => a.earned).reduce((sum, a) => sum + (a.xp || 0), 0);

    const achById = {};
    achievements.forEach(a => { achById[a.id] = a; });

    // ── XP events → frontend feed shape (newest first) ──
    const xpEvents = xpRes.data.map(e => {
      let label = '훈련 완료', icon = 'sports_esports', color = '#994626';
      if (e.reason === 'achievement') {
        const a = achById[e.refId];
        label = a ? a.title : '업적 달성';
        icon = a ? a.icon : 'workspace_premium';
        color = (a && RARITY_STYLE[a.rarity] ? RARITY_STYLE[a.rarity].color : null) || '#994626';
      } else if (e.reason === 'streak_bonus') {
        label = '7일 연속 훈련'; icon = 'local_fire_department'; color = '#DC2626';
      } else if (e.reason === 'goal_bonus') {
        label = '목표 달성 보너스'; icon = 'flag'; color = '#CA8A04';
      }
      return { date: e.createdAt, label, xp: e.amount, icon, color };
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

    // ── Windowed XP sums over the feed (same rule as computeStats) ──
    const todayN = dayNum(new Date());
    const weeklyXp = xpEvents.filter(e => { const n = dayNum(e.date); return n >= todayN - 6 && n <= todayN; })
      .reduce((sum, e) => sum + e.xp, 0);
    const todayXp = xpEvents.filter(e => dayNum(e.date) === todayN)
      .reduce((sum, e) => sum + e.xp, 0);

    // ── Session-derived aggregates (identical rules to computeStats) ──
    const avgSets = sess.length
      ? Math.round((sess.reduce((a, s) => a + (s.sets || 0), 0) / sess.length) * 10) / 10
      : 0;

    const inThisWeek = (s) => { const n = dayNum(s.date); return n >= todayN - 6 && n <= todayN; };
    const inPrevWeek = (s) => { const n = dayNum(s.date); return n >= todayN - 13 && n <= todayN - 7; };
    const thisWeek = sess.filter(inThisWeek);
    const prevWeek = sess.filter(inPrevWeek);
    const weeklyDoneDays = new Set(thisWeek.map(s => dayNum(s.date))).size;
    const weeklyGoalDays = Number(profile.goalDays) || 5;
    const meanForce = (arr) => arr.length ? arr.reduce((a, s) => a + (s.avgForce || 0), 0) / arr.length : null;
    const twForce = meanForce(thisWeek);
    const pwForce = meanForce(prevWeek);
    const weeklyForceDeltaPct = (twForce != null && pwForce != null && pwForce !== 0)
      ? ((twForce - pwForce) / pwForce) * 100
      : null;

    const recent = [...sess].sort((a, b) => new Date(b.date) - new Date(a.date));
    const recentSessions = recent.slice(0, 10).map(s => ({ ...s, gameId: gameIdOf(s), icon: iconForSession(s) }));

    return {
      totalXp,
      level,
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
  const rand = mulberry32(_seedFrom(20260709));
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
  // Auth guard: in REST mode an unauthenticated visit is bounced to the login screen.
  // (Game/calibration pages don't call initPage; they are covered by _fetch's _onAuthLost.)
  if (DataService.isRest() && !AuthService.isAuthenticated()) {
    const file = (typeof location !== 'undefined' && (location.pathname.split('/').pop() || 'index.html'));
    if (file && file !== 'login.html') {
      location.href = 'login.html?redirect=' + encodeURIComponent(file);
      return;
    }
  }

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
    AuthService, DataService, SensorService, GamificationEngine,
    GAME_DEFS, LEGACY_EXERCISE_ICONS, RARITY_STYLE, SENSOR_STATUS_META,
    gameIdOf, starsForScore, iconForSession, mulberry32, _seedFrom, deriveSetDetails,
    maxConsecutiveDays, dayNum, formatKoreanDate,
  };
}
