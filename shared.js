/* ReGrip — Shared JS
 *
 * Public surface (used by page scripts):
 *   DataService          — localStorage-first data layer, REST-switchable
 *   SensorService        — BLE / WebSocket / explicit simulation (sensor-service.js)
 *   GamificationEngine   — single source of truth for XP / levels / achievements / stats
 *                          (incl. rewardPreviewFor — local-mode reward preview)
 *   GAME_DEFS, GAME_TUNING, starsForScore, iconForSession, gameIdOf, mulberry32, deriveSetDetails
 *   gameConfig, intensityFor, recommendTraining
 *   GameShell            — common game-page shell (bootstrap / input / pause / result-save-reward)
 *   injectNav, initPage, formatKoreanDate, goBack
 *   renderSensorStatus, bindSensorBadge, injectFeedbackModal, openFeedbackModal, showToast, applyFontSize
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

// 하단 내비 전용 항목. 사이드바에는 이미 `nav-user`(→ profile.html)가 있으므로 NAV_ITEMS 에는 넣지 않는다.
// 모바일에서는 사이드바가 숨겨져 프로필(부상 유형·목표 악력·치료 시작일·담당 의사) 진입점이 사라지는 문제를 막는다.
const NAV_BOTTOM_EXTRA_ITEMS = [
  { key: 'profile', label: '프로필', icon: 'person', href: 'profile.html' },
];

// Inline SVG default avatar (retro person glyph) — no external hotlink, works offline.
const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' fill='%23D6E6F2'/%3E%3Ccircle cx='48' cy='36' r='16' fill='%235E86B8'/%3E%3Cpath d='M16 90c4-20 17-28 32-28s28 8 32 28z' fill='%235E86B8'/%3E%3C/svg%3E";

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
    <div id="nav-offline-badge" class="server-status" role="status" style="display:none;margin:0 16px 16px;background:#FEF3C7;color:#92400E;">
      <span class="dot"></span><span>오프라인 — 기록은 로컬에 보관됨</span>
    </div>
  `;

  // 하단 바 활성 키: profile.html 은 initPage(null) 로 호출하므로(프로필 페이지는 사이드바 기준으로
  // 어떤 탭도 활성이 아니다) 현재 파일명으로 'profile' 을 보정한다. 사이드바는 activeKey 를 그대로 쓴다.
  let bottomActiveKey = activeKey;
  try {
    const file = ((location.pathname.split('/').pop() || '')).toLowerCase();
    const hit = NAV_BOTTOM_EXTRA_ITEMS.find(it => it.href.toLowerCase() === file);
    if (hit) bottomActiveKey = hit.key;
  } catch {}

  const bottomLinksHtml = NAV_ITEMS.concat(NAV_BOTTOM_EXTRA_ITEMS).map(item => {
    const active = item.key === bottomActiveKey ? 'active' : '';
    const fill   = item.key === bottomActiveKey ? "style=\"font-variation-settings:'FILL' 1\"" : '';
    return `<a class="nav-bottom-item ${active}" href="${item.href}">
      <span class="material-symbols-outlined" ${fill}>${item.icon}</span>
      ${item.label}
    </a>`;
  }).join('');

  // The offline banner sits ABOVE the bottom bar (bottom:100% of the fixed #nav-bottom box) so it
  // never disturbs the nav-item row. Hidden unless REST mode is offline (renderOfflineBadge).
  bottom.innerHTML = bottomLinksHtml
    + `<div id="nav-offline-badge-bottom" class="server-status" role="status" style="display:none;position:absolute;bottom:100%;left:0;right:0;margin:0;justify-content:center;border-radius:0;border-width:2px 0 0 0;background:#FEF3C7;color:#92400E;">
      <span class="dot"></span><span>오프라인 — 기록은 로컬에 보관됨</span>
    </div>`;

  // Fill the freshly created badge with the current sensor state.
  renderSensorStatus();
  renderOfflineBadge();
}

// ── Feedback / Sensor-status Modal ───────────────────────────────────────────
// Content adapts to the current SensorService status: connected (all-good), simulation
// (how to attach a real device), disconnected/connecting (reconnect prompt).
const _feedbackModalState = { prevFocus: null, keyHandler: null };

function _feedbackContentFor(status) {
  if (status === 'connected') {
    return {
      icon: 'sensors', badge: '', title: '센서가 연결되어 있습니다.',
      body: '센서가 정상적으로 데이터를 수신하고 있습니다. 이대로 훈련을 진행하세요.',
      showReconnect: false,
      hint: '문제가 있으면 기기의 전원과 네트워크 연결 상태를 확인하세요.',
    };
  }
  if (status === 'simulation') {
    return {
      icon: 'science', badge: '', title: '시뮬레이션 모드입니다.',
      body: '실제 센서 없이 체험 중입니다. 게임 화면에서는 스페이스바 또는 화면 터치로 조작할 수 있습니다. 실기기를 연결하려면 설정에서 서버와 센서(ESP32) 주소를 등록하세요.',
      showReconnect: false,
      hint: 'ESP32가 같은 네트워크에서 WebSocket 서버(포트 8080)로 실행 중이어야 합니다.',
    };
  }
  // disconnected / connecting → 기존 문구 유지
  return {
    icon: 'sensors_off', badge: '!', title: '연결이 끊어졌습니다.',
    body: '센서를 다시 확인해 주세요. 장치가 올바르게 착용되었는지, 배터리가 충분한지 확인하시기 바랍니다.',
    showReconnect: true,
    hint: "센서 표시등이 파란색으로 깜빡이면 페어링 모드입니다. 기기의 설정에서 'ReGrip Sensor'를 선택하세요.",
  };
}

function _renderFeedbackModal(status) {
  const modal = document.getElementById('feedback-modal');
  if (!modal) return;
  const card = modal.querySelector('.modal-card');
  if (!card) return;
  const c = _feedbackContentFor(status);
  const reconnectBtn = c.showReconnect
    ? `<button class="btn-primary" onclick="SensorService.reconnect(); closeFeedbackModal()">
            <span class="material-symbols-outlined">restart_alt</span>
            재연결 시도
          </button>`
    : '';
  card.innerHTML = `
      <div class="modal-banner">
        <span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">warning</span>
        시스템 알림
      </div>
      <div class="modal-body">
        <div class="modal-icon">
          <span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">${c.icon}</span>
          ${c.badge ? `<div class="modal-badge">${c.badge}</div>` : ''}
        </div>
        <h2>${c.title}</h2>
        <p>${c.body}</p>
        <div class="modal-actions">
          ${reconnectBtn}
          <button class="btn-secondary" onclick="closeFeedbackModal()">
            <span class="material-symbols-outlined">close</span>
            닫기
          </button>
        </div>
      </div>
      <div class="modal-hint">
        <span class="material-symbols-outlined" style="color:#5E86B8;margin-top:2px;flex-shrink:0">help</span>
        <span><strong>도움말:</strong> ${c.hint}</span>
      </div>
  `;
}

function openFeedbackModal(context) {
  const modal = document.getElementById('feedback-modal');
  if (!modal) return;
  const status = (typeof SensorService !== 'undefined' && SensorService.getStatus) ? SensorService.getStatus() : 'disconnected';
  _renderFeedbackModal(status);
  _feedbackModalState.prevFocus = document.activeElement;
  modal.classList.add('open');
  const first = modal.querySelector('.modal-actions button');
  if (first && typeof first.focus === 'function') requestAnimationFrame(() => first.focus());
  _feedbackModalState.keyHandler = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFeedbackModal(); } };
  document.addEventListener('keydown', _feedbackModalState.keyHandler);
}

function closeFeedbackModal() {
  const modal = document.getElementById('feedback-modal');
  if (modal) modal.classList.remove('open');
  if (_feedbackModalState.keyHandler) {
    document.removeEventListener('keydown', _feedbackModalState.keyHandler);
    _feedbackModalState.keyHandler = null;
  }
  const pf = _feedbackModalState.prevFocus;
  _feedbackModalState.prevFocus = null;
  if (pf && typeof pf.focus === 'function') pf.focus();
}

function injectFeedbackModal() {
  if (document.getElementById('feedback-modal')) return;
  const el = document.createElement('div');
  el.id = 'feedback-modal';
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('role', 'dialog');
  el.innerHTML = `<div class="modal-card"></div>`;
  el.addEventListener('click', e => { if (e.target === el) closeFeedbackModal(); });
  document.body.appendChild(el);
  // Pre-fill so the card is never empty even before the first open.
  try {
    const status = (typeof SensorService !== 'undefined' && SensorService.getStatus) ? SensorService.getStatus() : 'disconnected';
    _renderFeedbackModal(status);
  } catch {}
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
  _revision: 0,
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
    const scope = DataService._storageScope(), revision = this._revision;
    try {
      const res = await fetch(DataService._apiUrl('/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !data.accessToken) return false;
      if (revision !== this._revision || scope !== DataService._storageScope()) return false;
      if (data.user && data.user.id !== (this.getUser() || {}).id) return false;
      this._store(data);
      return true;
    } catch (e) {
      console.warn('[AuthService] refresh 실패:', e && e.message);
      return false;
    }
  },

  async logout() {
    // Clear synchronously: a late logout response must not clear a subsequent login.
    this._clearTokens();
    try {
      await fetch(DataService._apiUrl('/auth/logout'), { method: 'POST', credentials: 'include' });
    } catch (e) {
      console.warn('[AuthService] logout 요청 실패(로컬 토큰은 삭제합니다):', e && e.message);
    }
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
    this._revision++;
    try {
      if (data.accessToken) localStorage.setItem('regrip_access_token', data.accessToken);
      if (data.user) localStorage.setItem('regrip_user', JSON.stringify(data.user));
      localStorage.setItem('regrip_auth_api_base', DataService._baseUrl);
      DataService._authLostHandled = false;
    } catch (e) { console.warn('[AuthService] 토큰 저장 실패:', e && e.message); }
  },
  _clearTokens() {
    this._revision++;
    try {
      localStorage.removeItem('regrip_access_token');
      localStorage.removeItem('regrip_user');
      localStorage.removeItem('regrip_auth_api_base');
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
// Session provenance is declared at game start; legacy rows stay unknown.
function escHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
const INPUT_SOURCE_LABELS = {ble:'센서 · Bluetooth',websocket:'센서 · Wi-Fi',simulation:'시뮬레이션',unknown:'출처 미상'};
function sessionSource(session) { return Object.hasOwn(INPUT_SOURCE_LABELS, session && session.inputSource) ? session.inputSource : 'unknown'; }
function sourceLabel(session) { return INPUT_SOURCE_LABELS[sessionSource(session)]; }
function matchesSessionSource(session, source = 'all') {
  const actual = sessionSource(session);
  return source === 'all' || (source === 'real' ? actual === 'ble' || actual === 'websocket' : actual === source);
}
function filterSessionSource(sessions, source = 'all') {
  if (!['all','real','simulation','unknown'].includes(source)) throw new RangeError('Unknown session source filter');
  return (Array.isArray(sessions) ? sessions : []).filter(s => matchesSessionSource(s, source)).map(s => ({...s,inputSource:sessionSource(s),calibrationSnapshot:s.calibrationSnapshot || null}));
}
function countSessionSources(sessions) {
  const counts={real:0,simulation:0,unknown:0};
  for (const s of sessions) {const actual=sessionSource(s);counts[actual==='ble'||actual==='websocket'?'real':actual]++;}
  return counts;
}
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
  // Unscoped keys remain the local-mode/legacy archive. Never infer their REST owner.
  _storageScope() {
    if (!this.isRest()) return 'local';
    const user = AuthService.getUser();
    return 'rest:' + encodeURIComponent(this._baseUrl) + ':' + encodeURIComponent(user && user.id || '@unowned');
  },
  _storageKey(key, scope = this._storageScope()) {
    const scoped = ['regrip_sessions', 'regrip_outbox', 'regrip_profile', 'regrip_settings', 'regrip_calibration', 'regrip_migration_prompted'];
    return scope !== 'local' && scoped.includes(key) ? key + ':v2:' + scope : key;
  },
  _canSendFor(scope) {
    if (!this.isRest() || scope !== this._storageScope() || !(AuthService.getUser() || {}).id || !AuthService.isAuthenticated()) return false;
    try {
      const authBase = localStorage.getItem('regrip_auth_api_base');
      if (authBase !== null && authBase !== this._baseUrl) return false;
    } catch {}
    return true;
  },
  _readLocal(key, fallback, scope = this._storageScope()) {
    try {
      const v = JSON.parse(localStorage.getItem(this._storageKey(key, scope)));
      return v == null ? fallback : v;
    } catch { return fallback; }
  },
  _writeLocal(key, data, scope = this._storageScope()) {
    try { localStorage.setItem(this._storageKey(key, scope), JSON.stringify(data)); } catch (e) {
      console.warn(`[DataService] localStorage write failed for ${key}:`, e && e.message);
    }
  },

  // ── REST helper ──
  // GET/PUT/POST against {apiBase}/api/v1{path}. Injects Bearer token + credentials.
  // On 401: tries AuthService.refresh() once, retries the request, else clears tokens
  // and routes to login (via _onAuthLost). Returns parsed JSON ({} for empty body) on
  // success, or null on any failure (callers fall back to their localStorage mirror).
  async _fetch(path, opts = {}, _retry = true, scope = this._storageScope()) {
    if (scope !== 'local' && !this._canSendFor(scope)) return null;
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
      _regripMarkOnline();   // a response (any status) means the network is up (F3)

      if (res.status === 401 && _retry) {
        if (!this._canSendFor(scope)) return null;
        const revision = AuthService._revision;
        const recovered = await AuthService.refresh();
        if (recovered && this._canSendFor(scope)) return this._fetch(path, opts, false, scope);
        if (revision !== AuthService._revision) return null;
        if (!this._canSendFor(scope)) return null;
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
      _regripMarkOffline();   // fetch threw → network down (F3)
      console.warn(`[DataService] ${opts.method || 'GET'} ${path} failed:`, e && e.message);
      return null;
    }
  },

  // ── Profile ──
  getProfileSync() {
    return this._readLocal('regrip_profile', {});   // localStorage mirror
  },

  async getProfile() {
    const scope = this._storageScope();
    if (this._backend === 'rest') {
      const data = await this._fetch('/users/me/profile');
      if (data) this._writeLocal('regrip_profile', data, scope);
      if (scope !== this._storageScope()) return this.getProfileSync();
      if (data) return data;
      return this.getProfileSync();                                         // fallback to mirror
    }
    return this.getProfileSync();
  },

  async saveProfile(data) {
    const scope = this._storageScope();
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
        this._writeLocal('regrip_profile', res, scope);
        return res;
      }
      console.warn('[DataService] saveProfile REST 실패 — 로컬 미러에 저장합니다.');
      this._writeLocal('regrip_profile', { ...this._readLocal('regrip_profile', {}, scope), ...data }, scope);
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
      inputSource: sessionSource(s),
      calibrationSnapshot: s.calibrationSnapshot || null,
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
  async getSessions(source = 'all') {
    const scope = this._storageScope();
    const cached = () => scope === this._storageScope() ? filterSessionSource(this._readLocal('regrip_sessions', [], scope), source) : [];
    if (this._backend !== 'rest') return cached();
    const mapped = [], seenCursors = new Set();
    let cursor = null;
    do {
      const query = '/users/me/sessions?limit=100&source=' + encodeURIComponent(source) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const res = await this._fetch(query, {}, true, scope);
      if (scope !== this._storageScope()) return [];
      if (!res || !Array.isArray(res.data)) return cached();
      mapped.push(...res.data.map(s => this._sessionFromServer(s)));
      cursor = res.meta && res.meta.nextCursor;
      if (cursor && seenCursors.has(cursor)) return cached();
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    const old = this._readLocal('regrip_sessions', [], scope);
    const pending = new Set(this._readOutbox(scope).map(s => s.clientSessionId));
    const serverIds = new Set(mapped.map(s => s.clientSessionId || s.id));
    const retained = old.filter(s => !serverIds.has(s.clientSessionId || s.id) &&
      (!matchesSessionSource(s, source) || pending.has(s.clientSessionId)));
    const merged = [...mapped, ...retained].sort((a,b) => new Date(b.date) - new Date(a.date));
    this._writeLocal('regrip_sessions', merged, scope);
    return filterSessionSource(merged, source);
  },
  // Prepend a session object to the local mirror (newest first).
  _mirrorSession(session, scope = this._storageScope()) {
    const sessions = this._readLocal('regrip_sessions', [], scope);
    sessions.unshift(session);
    this._writeLocal('regrip_sessions', sessions, scope);
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
      inputSource: sessionSource(data),
      calibrationSnapshot: data.calibrationSnapshot ? JSON.parse(JSON.stringify(data.calibrationSnapshot)) : null,
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
    const scope = this._storageScope();
    data = { ...data, inputSource: sessionSource(data), calibrationSnapshot: data.calibrationSnapshot ? JSON.parse(JSON.stringify(data.calibrationSnapshot)) : null };
    if (this._backend === 'rest') {
      // Idempotency: reuse/generate a clientSessionId and mirror the session locally FIRST so a
      // retry (offline queue) re-sends the SAME key and the server dedupes it.
      const clientSessionId = data.clientSessionId || _uuid();
      data.clientSessionId = clientSessionId;
      this._mirrorSession({ ...data, id: data.id || clientSessionId, clientSessionId }, scope);

      const gid = gameIdOf(data);
      if (!gid) {
        // Legacy demo-labelled session with no resolvable gameId → not in the server enum.
        console.warn('[DataService] saveSession: exerciseType 를 유도할 수 없어 서버 전송을 생략합니다(로컬 저장만).', data.label);
        return undefined;
      }
      const payload = this._sessionToPayload(data, clientSessionId, 'game_' + gid);
      // Persist before the first await so navigation or a concurrent history read cannot lose it.
      this._enqueueOutbox(payload, scope);
      const res = await this._fetch('/users/me/sessions', { method: 'POST', body: payload }, true, scope);
      if (res === null) {
        // It was already queued before the request. A concurrent retry may have acknowledged
        // it while this request was pending, so do not resurrect a removed entry here.
        console.warn('[DataService] saveSession REST 실패 — 로컬 미러 + 아웃박스에 적재(오프라인 내성).');
        return undefined;
      }
      this._writeOutbox(this._readOutbox(scope).filter(p => p.clientSessionId !== clientSessionId), scope);
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
    const scope = this._storageScope();
    const local = this.getSettingsSync();
    if (this._backend === 'rest') {
      const data = await this._fetch('/users/me/settings');
      if (data) {
        // Server fields override shared keys; local-only fields (reducedMotion, sensorName)
        // are always kept from localStorage (the server has no reducedMotion).
        const merged = { ...local, ...data, reducedMotion: local.reducedMotion };
        this._writeLocal('regrip_settings', merged, scope);
        return scope === this._storageScope() ? merged : this.getSettingsSync();
      }
      return scope === this._storageScope() ? local : this.getSettingsSync();
    }
    return local;
  },

  async saveSettings(data) {
    // Local-only fields (reducedMotion, sensorName, …) always persist to the mirror.
    this._writeLocal('regrip_settings', data);
    if (this._backend === 'rest') {
      const payload = {};
      const keep = ['hand', 'difficulty', 'restSeconds', 'reminderEnabled', 'reminderTime', 'sessionSummaryEnabled', 'timezone', 'fontSize'];
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
    const scope = this._storageScope();
    if (this._backend === 'rest') {
      const data = await this._fetch('/users/me/calibrations/latest', { silent404: true });
      if (data && data.baselineRaw0 != null) {
        const cal = { baseline0: data.baselineRaw0, baseline100: data.baselineRaw100, date: data.calibratedAt };
        this._writeLocal('regrip_calibration', cal, scope);
        return scope === this._storageScope() ? cal : null;
      }
      // No calibration yet is a normal state: the server answers 204 (empty body → {}), and an
      // older server may answer 404 (silenced above). Either way we fall back to the local mirror.
      return scope === this._storageScope() ? this._readLocal('regrip_calibration', null, scope) : null;
    }
    return this._readLocal('regrip_calibration', null);
  },

  async saveCalibration(data) {
    const scope = this._storageScope();
    if (this._backend === 'rest') {
      const payload = { baselineRaw0: data.baseline0, baselineRaw100: data.baseline100 };
      const res = await this._fetch('/users/me/calibrations', { method: 'POST', body: payload });
      if (res === null) console.warn('[DataService] saveCalibration REST 실패 — 로컬에 저장합니다.');
      this._writeLocal('regrip_calibration', { baseline0: data.baseline0, baseline100: data.baseline100, date: data.date }, scope);
    } else {
      this._writeLocal('regrip_calibration', data);
    }
  },

  // ── Offline outbox (F1/B3) ──
  // regrip_outbox durably holds session POST payloads until acknowledged by the server. Each payload
  // carries its own clientSessionId (idempotency key), so re-sending is safe (server dedupes).
  _readOutbox(scope = this._storageScope()) {
    const q = this._readLocal('regrip_outbox', [], scope);
    return Array.isArray(q) ? q : [];
  },
  _writeOutbox(q, scope = this._storageScope()) {
    this._writeLocal('regrip_outbox', Array.isArray(q) ? q : [], scope);
  },
  _enqueueOutbox(payload, scope = this._storageScope()) {
    if (!payload || !payload.clientSessionId) return;
    const q = this._readOutbox(scope);
    if (q.some(p => p && p.clientSessionId === payload.clientSessionId)) return;   // dedupe by idempotency key
    q.push(payload);
    this._writeOutbox(q, scope);
  },

  // Raw session POST that SURFACES the HTTP status + error code — unlike _fetch, which collapses
  // every failure to null. Migration/outbox must distinguish the daily-cap 422 (stop, retry later)
  // from a permanent 4xx (drop) and from a transient network/5xx (retry). Returns
  // { ok, status, errorCode, message }. Retries once through AuthService.refresh() on 401.
  async _sendSessionPayload(payload, _retry = true, scope = this._storageScope()) {
    if (!this._canSendFor(scope)) return { ok: false, status: 0, errorCode: 'OWNER_CHANGED', message: '' };
    try {
      const headers = { ...this._headers, 'Content-Type': 'application/json' };
      const tok = AuthService.getAccessToken();
      if (tok) headers['Authorization'] = 'Bearer ' + tok;
      const res = await fetch(this._apiUrl('/users/me/sessions'), {
        method: 'POST', headers, body: JSON.stringify(payload), credentials: 'include',
      });
      _regripMarkOnline();
      if (res.status === 401 && _retry) {
        if (!this._canSendFor(scope)) return { ok: false, status: 0, errorCode: 'OWNER_CHANGED', message: '' };
        const recovered = await AuthService.refresh();
        if (recovered) return this._sendSessionPayload(payload, false, scope);
      }
      if (res.ok) return { ok: true, status: res.status, errorCode: '', message: '' };
      let errorCode = '', message = '';
      try { const j = await res.json(); if (j && j.error) { errorCode = j.error.code || ''; message = j.error.message || ''; } } catch {}
      return { ok: false, status: res.status, errorCode, message };
    } catch (e) {
      _regripMarkOffline();
      return { ok: false, status: 0, errorCode: 'NETWORK', message: (e && e.message) || '' };
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
// OFFLINE STATUS (F3) + REST-MODE BACKGROUND SYNC (F1: migration + outbox)
//
// REST mode only. Connectivity is derived from navigator.onLine (online/offline events) and
// from _fetch/_sendSessionPayload success/failure. When offline, a compact badge appears in the
// nav (sidebar + bottom banner). Coming back online repaints the badge and drains the outbox.
// Local mode shows nothing and syncs nothing.
// ═══════════════════════════════════════════════════════════════════════════════
let _regripOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);

function _regripMarkOnline()  { _regripSetOffline(false); }
function _regripMarkOffline() { _regripSetOffline(true); }

function _regripSetOffline(offline) {
  const changed = _regripOffline !== offline;
  _regripOffline = offline;
  if (changed) renderOfflineBadge();
  if (changed && !offline) {
    // Back online → best-effort silent outbox flush (idempotent; no-op in local mode).
    try { if (DataService.isRest() && AuthService.isAuthenticated()) resendOutbox(); } catch {}
  }
}

// Show/hide the offline badge (REST + offline only). Elements are created by injectNav.
function renderOfflineBadge() {
  if (typeof document === 'undefined') return;
  const show = DataService.isRest() && _regripOffline;
  ['nav-offline-badge', 'nav-offline-badge-bottom'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  });
}

// Daily-cap 422: the server refuses more than 20 sessions/receipt-day. Distinguish it (by message)
// from other 422s (backdate-too-old, validation) so the drain stops instead of dropping records.
function _regripIsDailyCap(r) {
  return !!r && r.status === 422 && /daily session limit/i.test(r.message || '');
}

// Drain regrip_outbox: re-POST each queued payload idempotently. ok / permanent-4xx entries are
// removed; daily-cap stops the drain (remaining wait for tomorrow); transient (network/401/429/5xx)
// stay queued for the next load. Silent except a success toast when ≥1 record lands.
const _regripResendingScopes = new Set();
async function resendOutbox() {
  const scope = DataService._storageScope();
  if (_regripResendingScopes.has(scope) || !DataService._canSendFor(scope)) return { sent: 0, capped: false };
  _regripResendingScopes.add(scope);
  try {
    const queue = DataService._readOutbox(scope);
    if (!queue.length) return { sent: 0, capped: false };
    const remaining = [];
    let sent = 0, capped = false;
    for (const payload of queue) {
      if (capped) { remaining.push(payload); continue; }
      const r = await DataService._sendSessionPayload(payload, true, scope);
      if (r.ok) { sent++; continue; }
      if (_regripIsDailyCap(r)) { capped = true; remaining.push(payload); continue; }
      // Permanent client rejection (backdate-too-old / validation): retrying can't help → drop.
      if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
        console.warn('[outbox] 영구 거부로 폐기:', r.status, r.errorCode, r.message);
        continue;
      }
      remaining.push(payload);   // transient → keep for next attempt
    }
    // A new session may be enqueued while this drain awaits a response. Keep new entries,
    // and do not resurrect an entry already acknowledged by its initial POST.
    const processed = new Set(queue.map(p => p.clientSessionId));
    const retry = new Set(remaining.map(p => p.clientSessionId));
    DataService._writeOutbox(DataService._readOutbox(scope).filter(p => !processed.has(p.clientSessionId) || retry.has(p.clientSessionId)), scope);
    if (sent > 0 && scope === DataService._storageScope()) { try { showToast(`밀린 기록 ${sent}건 서버 반영`, { type: 'success' }); } catch {} }
    return { sent, capped };
  } finally {
    _regripResendingScopes.delete(scope);
  }
}

// One-time (per browser) prompt after first authenticated REST page load: offer to upload
// local-only sessions (created before login) to the server account.
async function maybePromptMigration() {
  if (typeof localStorage === 'undefined') return;
  const scope = DataService._storageScope();
  if (!DataService._canSendFor(scope)) return;
  if (DataService._readLocal('regrip_migration_prompted', false, scope)) return;

  const all = DataService._readLocal('regrip_sessions', [], 'local') || [];
  // Local-only = a genuine local record: not a demo seed, not server-originated (fromServer),
  // and resolvable to a server game enum (gameIdOf). Non-game legacy labels stay local (as saveSession does).
  const candidates = all.filter(s => s && !s.demo && !s.fromServer && gameIdOf(s));
  if (!candidates.length) return;

  // 72h backdate floor: the server rejects startedAt older than 72h. Only fresh sessions are
  // uploadable; a 5-min buffer keeps a near-edge session from tipping over during upload latency.
  const now = Date.now();
  const H72 = 72 * 3600 * 1000, BUFFER = 5 * 60 * 1000;
  const within = [], tooOld = [];
  for (const s of candidates) {
    const t = new Date(s.date).getTime();
    const age = now - t;
    if (!Number.isFinite(t) || age < 0) { within.push(s); continue; }   // unknown/future → treat as fresh
    (age <= H72 - BUFFER ? within : tooOld).push(s);
  }

  const markPrompted = () => DataService._writeLocal('regrip_migration_prompted', true, scope);

  if (!within.length) { markPrompted(); return; }   // nothing uploadable → don't re-check every load

  const n = within.length, m = tooOld.length;
  const body = `로컬 기록 ${n}건을 서버에 업로드할까요?`
    + (m ? ` 그 이전 기록 ${m}건은 72시간이 지나 로컬에만 보관됩니다.` : '');

  openConfirmModal({
    title: '로컬 기록 업로드',
    body,
    confirmLabel: '업로드',
    cancelLabel: '나중에',
    onConfirm: () => { _migrateSessions(within, scope); },
  });
  // Prompt exactly once: persist the flag now so neither "나중에" nor a partial async upload re-prompts.
  markPrompted();
}

// Sequentially upload the given local sessions. Assign+persist a clientSessionId BEFORE sending so
// a reload mid-migration re-sends the SAME key (server dedupes). Daily-cap → remaining to outbox.
async function _migrateSessions(sessions, scope = DataService._storageScope()) {
  if (!DataService._canSendFor(scope)) return;
  const mirror = DataService._readLocal('regrip_sessions', [], 'local') || [];
  for (const s of sessions) {
    if (!s.clientSessionId) s.clientSessionId = _uuid();
    const hit = mirror.find(mm => mm === s || (mm && s.id != null && mm.id === s.id));
    if (hit) hit.clientSessionId = s.clientSessionId;
  }
  DataService._writeLocal('regrip_sessions', mirror, 'local');   // preserve original local history

  const toPayload = (s) => DataService._sessionToPayload(s, s.clientSessionId, 'game_' + gameIdOf(s));
  const owned = DataService._readLocal('regrip_sessions', [], scope);
  const ids = new Set(owned.map(s => s.clientSessionId));
  for (const s of sessions) {
    if (!ids.has(s.clientSessionId)) { owned.push({ ...s }); ids.add(s.clientSessionId); }
    DataService._enqueueOutbox(toPayload(s), scope);
  }
  DataService._writeLocal('regrip_sessions', owned, scope);

  let sent = 0, failed = 0, capped = false;
  for (const s of sessions) {
    const payload = toPayload(s);
    if (capped) continue;
    const r = await DataService._sendSessionPayload(payload, true, scope);
    if (r.ok) {
      DataService._writeOutbox(DataService._readOutbox(scope).filter(p => p.clientSessionId !== payload.clientSessionId), scope);
      sent++; continue;
    }
    if (_regripIsDailyCap(r)) { capped = true; continue; }
    failed++;
    if (r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 429) {
      DataService._writeOutbox(DataService._readOutbox(scope).filter(p => p.clientSessionId !== payload.clientSessionId), scope);
    }
  }

  const parts = [];
  if (sent > 0) parts.push(`기록 ${sent}건 서버 반영 완료`);
  if (capped) parts.push('일일 한도 초과분은 내일 자동 재시도됩니다');
  else if (failed > 0) parts.push(`${failed}건은 나중에 다시 시도합니다`);
  if (parts.length && scope === DataService._storageScope()) {
    try { showToast(parts.join(' · '), { type: (capped || failed) ? 'info' : 'success' }); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sensor transport is owned by sensor-service.js.
const SensorService = globalThis.SensorService || (typeof require === "function" ? require("./sensor-service.js").createSensorService() : null);
// GAME DEFINITIONS & SESSION HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
const GAME_DEFS = {
  balloon: { label: '풍선 게임',     icon: 'sports_esports', starThresholds: [5, 10],  page: 'game-balloon.html', durationLabel: '2분',       axis: '정적 유지', baseIntensity: 2, desc: '목표 구간에 악력을 유지해 풍선을 부풀리세요' },
  crane:   { label: '크레인 게임',   icon: 'precision_manufacturing', starThresholds: [3, 5],   page: 'game-crane.html',   durationLabel: '60초',      axis: '파지·이완', baseIntensity: 3, desc: '꽉 쥐어 캡슐을 집고, 천천히 놓아 배출구에 넣으세요' },
  rhythm:  { label: '리듬 펌프 게임', icon: 'music_note',     starThresholds: [14, 20], page: 'game-rhythm.html',  durationLabel: '3세트×8회', axis: '반복 쥐기', baseIntensity: 2, desc: '박자에 맞춰 쥐었다 완전히 풀며 열기구를 띄우세요' },
  glide:   { label: '잠수함 게임',   icon: 'sailing',        starThresholds: [15, 24], page: 'game-glide.html',   durationLabel: '90초',      axis: '정밀 추적', baseIntensity: 3, desc: '악력으로 잠수함 심도를 조절해 게이트를 통과하세요' },
};

// label → id reverse map (built once at module load). Lets a legacy session that carries
// only a label — no gameId — resolve to its id without the old hardcoded ternary.
const GAME_LABEL_TO_ID = {};
for (const [_gid, _def] of Object.entries(GAME_DEFS)) GAME_LABEL_TO_ID[_def.label] = _gid;

// Icons for legacy (pre-schema-2) exercise-labelled sessions.
const LEGACY_EXERCISE_ICONS = {
  '완전 그립 훈련': 'fitness_center',
  '핀치 그립 훈련': 'pinch',
  '측면 그립 훈련': 'pan_tool',
  '손가락 펴기':   'back_hand',
};

// Resolve a session's game id from an explicit field or its legacy label.
// Behavior parity with the previous hardcoded ternary: gameId wins, else label reverse-lookup, else null.
function gameIdOf(s) {
  if (!s) return null;
  if (s.gameId) return s.gameId;
  if (s.label && GAME_LABEL_TO_ID[s.label]) return GAME_LABEL_TO_ID[s.label];
  return null;
}

// Display intensity (1–5 dots on training cards): baseIntensity ± difficulty offset, clamped 1–5.
function intensityFor(gameId, difficulty) {
  const def = GAME_DEFS[gameId];
  const base = def ? def.baseIntensity : 2;
  const off = difficulty === 'easy' ? -1 : difficulty === 'hard' ? 1 : 0;
  return Math.max(1, Math.min(5, base + off));
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

// ── Game tuning (difficulty-parameterized) ───────────────────────────────────
// Per-difficulty raw parameters. IMPORTANT: force is ALWAYS recorded as absolute %.
// goalForce only relativizes TARGET lines (e.g. crane grab target) — never the recorded force.
const GAME_TUNING = {
  balloon: { easy: { targetBand: 28 }, medium: { targetBand: 20 }, hard: { targetBand: 12 } },
  crane:   { easy: { grabMul: 0.75 },  medium: { grabMul: 1.0 },   hard: { grabMul: 1.125 } },
  // rhythm hard: 템포는 medium과 동일(1800ms) — 시뮬 램프(+55/-45%/s)의 완전 이완+재쥐기
  // 1사이클(55% 기준 ~1.62s)이 박자 안에 들어와야 해서, 어려움은 힘(55%)과 판정창(350ms)이 담당.
  rhythm:  { easy: { squeezeTh: 30, beatMs: 2200, windowMs: 600 }, medium: { squeezeTh: 40, beatMs: 1800, windowMs: 450 }, hard: { squeezeTh: 55, beatMs: 1800, windowMs: 350 } },
  glide:   { easy: { tolerance: 12 },  medium: { tolerance: 8 },   hard: { tolerance: 5 } },
};

// Normalize a settings.difficulty value: legacy 'normal' → 'medium'; unknown/unset → 'easy'.
function _normalizeDifficulty(d) {
  if (d === 'normal') return 'medium';
  return (d === 'easy' || d === 'medium' || d === 'hard') ? d : 'easy';
}

// Resolve the full runtime config for a game: common fields + difficulty tuning + per-game
// derived fields. Node-safe (no localStorage → defaults; never throws).
function gameConfig(gameId) {
  let settings = {}, profile = {};
  try { settings = DataService.getSettingsSync() || {}; } catch {}
  try { profile = DataService.getProfileSync() || {}; } catch {}

  const difficulty = _normalizeDifficulty(settings.difficulty);
  const restSeconds = Number(settings.restSeconds) || 30;   // settings.html 표기 기본값(30초)과 일치
  const handUsed = (settings.hand === 'left' || settings.hand === 'right') ? settings.hand : null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let goalForce = Number(profile.goalForce);
  if (!Number.isFinite(goalForce)) goalForce = 80;
  goalForce = clamp(Math.round(goalForce), 40, 95);

  const tuning = (GAME_TUNING[gameId] && GAME_TUNING[gameId][difficulty]) || {};
  const cfg = { gameId, difficulty, restSeconds, handUsed, goalForce, ...tuning };

  if (gameId === 'crane') {
    // The single place target lines are relativized. Recorded force stays absolute %.
    // Worked check (medium, goal 80): grab=round(80*1.0)=80, descendMin=max(30,70)=70,
    //   carry=round(80*0.625)=50, release=round(80*0.5)=40.
    const grabForce = clamp(Math.round(goalForce * cfg.grabMul), 40, 95);
    cfg.grabForce = grabForce;
    cfg.descendMinForce = Math.max(30, grabForce - 10);
    cfg.carryMinForce = Math.round(grabForce * 0.625);
    cfg.releaseForce = Math.round(grabForce * 0.5);
    cfg.graceMs = 500;
  } else if (gameId === 'rhythm') {
    cfg.releaseTh = 15;
    cfg.sets = 3;
    cfg.reps = 8;
  } else if (gameId === 'glide') {
    cfg.pathLo = 20;
    cfg.pathHi = 70;
    cfg.gates = 30;
    cfg.gateIntervalMs = 3000;
    cfg.durationSec = 90;
    cfg.maxSlopePctPerSec = 20;
  } else if (gameId === 'balloon') {
    cfg.targetHoldPct = 60;
  }

  return cfg;
}

// Suggest the next training game. Returns { gameId, def, reason, intensity }.
// Priority: ① never-played (GAME_DEFS key order) → ② longest-not-played → ③ lowest avg stars.
function recommendTraining(sessions) {
  if (!Array.isArray(sessions)) {
    try { sessions = DataService._readLocal('regrip_sessions', []) || []; } catch { sessions = []; }
  }
  let difficulty = 'medium';
  try { difficulty = _normalizeDifficulty((DataService.getSettingsSync() || {}).difficulty); } catch {}

  const ids = Object.keys(GAME_DEFS);   // insertion order: balloon, crane, rhythm, glide
  const pick = (gameId, reason) => ({ gameId, def: GAME_DEFS[gameId], reason, intensity: intensityFor(gameId, difficulty) });

  if (!sessions.length) return pick('balloon', '첫 훈련을 시작해보세요');

  const byGame = {};
  for (const s of sessions) {
    const gid = gameIdOf(s);
    if (!gid || !GAME_DEFS[gid]) continue;
    (byGame[gid] || (byGame[gid] = [])).push(s);
  }

  // ① never-played game (in key order)
  for (const id of ids) {
    if (!byGame[id] || !byGame[id].length) return pick(id, '아직 안 해본 게임이에요');
  }

  // ② longest-not-played game (oldest last-play day)
  const today = dayNum(new Date());
  let oldestId = null, oldestDay = Infinity;
  for (const id of ids) {
    const lastDay = Math.max(...byGame[id].map(s => dayNum(s.date)));
    if (lastDay < oldestDay) { oldestDay = lastDay; oldestId = id; }
  }
  const daysSince = today - oldestDay;
  if (daysSince >= 1) return pick(oldestId, `${daysSince}일 만이에요`);

  // ③ all recent → lowest average stars among games with ≥2 sessions
  let worstId = null, worstAvg = Infinity;
  for (const id of ids) {
    const arr = byGame[id];
    if (arr.length < 2) continue;
    const avg = arr.reduce((a, s) => a + (s.stars || 0), 0) / arr.length;
    if (avg < worstAvg) { worstAvg = avg; worstId = id; }
  }
  if (worstId) return pick(worstId, '별점을 올려볼까요?');

  return pick(oldestId || ids[0], '별점을 올려볼까요?');
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
  if (!Number.isFinite(d.getTime())) return NaN;
  const timezone = DataService.getSettingsSync().timezone || 'Asia/Seoul';
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year:'numeric',month:'numeric',day:'numeric'}).formatToParts(d); }
  catch { parts = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Seoul',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(d); }
  const part = type => Number(parts.find(p => p.type === type).value);
  return Math.floor(Date.UTC(part('year'), part('month') - 1, part('day')) / DAY_MS);
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
  const number = dayNum(isoString);
  if (!Number.isFinite(number)) return '—';
  const d = new Date(number * DAY_MS);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
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
    { name: '마스터', min: 81, max: 100, range: 'Lv. 81 ~ 100', icon: 'workspace_premium',    color: '#2A4A6F', bg: '#D6E6F2' },
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
    {
      id: 'first_rhythm', title: '첫 박자', icon: 'music_note',
      desc: '리듬 펌프 게임에서 첫 세션을 완료했습니다.', condition: '리듬 펌프 게임 1회 완료',
      category: '게임 플레이', rarity: '일반', xp: 100, goal: 1,
      measure: (sessions) => sessions.filter(s => gameIdOf(s) === 'rhythm' && (s.sets || 0) >= 1).length,
    },
    {
      id: 'first_glide', title: '첫 항해', icon: 'sailing',
      desc: '잠수함 게임에서 첫 항로를 완주했습니다.', condition: '잠수함 게임 1회 완료',
      category: '게임 플레이', rarity: '일반', xp: 100, goal: 1,
      measure: (sessions) => sessions.filter(s => gameIdOf(s) === 'glide' && (s.sets || 0) >= 1).length,
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

  computeStats(sessions, profile, source = 'all') {
    sessions = Array.isArray(sessions) ? sessions : [];
    profile = profile || {};

    const measured = filterSessionSource(sessions, source);
    const totalSessions = measured.length;
    const chrono = [...sessions].sort((a, b) => new Date(a.date) - new Date(b.date));
    const recent = [...measured].sort((a, b) => new Date(b.date) - new Date(a.date));

    // ── Streak & session XP ──
    const streak = this.computeStreak(sessions);
    const sessionXp = sessions.reduce((sum, s) => sum + this.xpForSession(s), 0);
    const streakBonus = streak >= 7 ? this.XP_RULES.streak7Bonus : 0;

    // ── Aggregates ──
    const maxForce = measured.reduce((m, s) => Math.max(m, s.maxForce || 0), 0);
    const avgSets = totalSessions
      ? Math.round((measured.reduce((a, s) => a + (s.sets || 0), 0) / totalSessions) * 10) / 10
      : 0;

    // ── Weekly windows (calendar days) ──
    const todayN = dayNum(new Date());
    const inThisWeek = (s) => { const n = dayNum(s.date); return n >= todayN - 6 && n <= todayN; };
    const inPrevWeek = (s) => { const n = dayNum(s.date); return n >= todayN - 13 && n <= todayN - 7; };
    const thisWeek = measured.filter(inThisWeek);
    const prevWeek = measured.filter(inPrevWeek);

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
      xpEvents.push({ date: s.date, label: `${def ? def.label : (s.label || '훈련')} 완료`, xp: baseXp, icon: iconForSession(s), color: '#5E86B8' });
      if (s.stars === 3)      xpEvents.push({ date: s.date, label: '별 3개 보너스', xp: this.XP_RULES.threeStarBonus, icon: 'star', color: '#CA8A04' });
      else if (s.stars === 2) xpEvents.push({ date: s.date, label: '별 2개 보너스', xp: this.XP_RULES.twoStarBonus, icon: 'star', color: '#CA8A04' });
    }
    if (streak >= 7) {
      xpEvents.push({ date: new Date().toISOString(), label: '7일 연속 훈련', xp: this.XP_RULES.streak7Bonus, icon: 'local_fire_department', color: '#DC2626' });
    }
    for (const a of achievements) {
      if (a.earned && a.earnedDateRaw) {
        xpEvents.push({ date: a.earnedDateRaw, label: a.title, xp: a.xp, icon: a.icon, color: (RARITY_STYLE[a.rarity] || {}).color || '#5E86B8' });
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
      source, allSessionCount: sessions.length, sourceCounts: countSessionSources(sessions),
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

  // Local-mode reward preview for a just-finished session (mirrors the server's save-session
  // reward shape so the game result overlay renders identically without a backend).
  // Reuses computeStats's totalXp derivation on prev vs [session,...prev] so the awarded XP is
  // exactly the delta (invariant Σxp_events === totalXp → no formula re-implementation).
  rewardPreviewFor(prevSessions, session) {
    const prev = Array.isArray(prevSessions) ? prevSessions : [];
    const after = [session, ...prev];

    const before = this.computeStats(prev, {});
    const now = this.computeStats(after, {});

    const xpAwarded = Math.max(0, (now.totalXp || 0) - (before.totalXp || 0));
    const levelUp = now.level > before.level;

    // Newly unlocked achievements: measure(prev) < goal && measure(after) >= goal.
    const chrPrev = [...prev].sort((a, b) => new Date(a.date) - new Date(b.date));
    const chrAfter = [...after].sort((a, b) => new Date(a.date) - new Date(b.date));
    const unlockedAchievements = [];
    for (const def of this.ACHIEVEMENTS) {
      const wasBefore = def.measure(chrPrev) >= def.goal;
      const nowUnlocked = def.measure(chrAfter) >= def.goal;
      if (!wasBefore && nowUnlocked) {
        unlockedAchievements.push({ id: def.id, title: def.title, rewardXp: def.xp, rarity: def.rarity });
      }
    }

    return { xpAwarded, totalXp: now.totalXp, level: now.level, levelUp, unlockedAchievements };
  },

  async getStats(source = 'all') {
    if (DataService.isRest()) return this._statsFromServer(source);
    return this.computeStats(await DataService.getSessions(), DataService.getProfileSync(), source);
  },

  // REST mode: the server is the source of truth for XP / level / streak / achievements.
  // Returns the SAME shape (keys) as computeStats so all six pages render unchanged.
  // If any server fetch fails, falls back to local computation (warns once).
  _serverFallbackWarned: false,
  async _statsFromServer(source = 'all') {
    const scope = DataService._storageScope();
    const profile = DataService.getProfileSync();
    const [statsRes, achRes, xpRes, sessions] = await Promise.all([
      DataService._fetch('/users/me/stats?source=' + encodeURIComponent(source)),
      DataService._fetch('/users/me/achievements'),
      DataService._fetch('/users/me/xp-events?limit=100'),
      DataService.getSessions(source),
    ]);
    if (scope !== DataService._storageScope()) {
      return this.computeStats(DataService._readLocal('regrip_sessions', []), DataService.getProfileSync(), source);
    }

    if (!statsRes || !achRes || !Array.isArray(achRes.data) || !xpRes || !Array.isArray(xpRes.data)) {
      if (!this._serverFallbackWarned) {
        console.warn('[GamificationEngine] 서버 통계 조회 실패 — 로컬 계산으로 폴백합니다.');
        this._serverFallbackWarned = true;
      }
      return this.computeStats(DataService._readLocal('regrip_sessions', []), profile, source);
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
      let label = '훈련 완료', icon = 'sports_esports', color = '#5E86B8';
      if (e.reason === 'achievement') {
        const a = achById[e.refId];
        label = a ? a.title : '업적 달성';
        icon = a ? a.icon : 'workspace_premium';
        color = (a && RARITY_STYLE[a.rarity] ? RARITY_STYLE[a.rarity].color : null) || '#5E86B8';
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
      source, allSessionCount: statsRes.allSessionCount ?? totalSessions, sourceCounts: statsRes.sourceCounts || countSessionSources(sess),
      chart: statsRes.chart || [],
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
  stale:        { label: '센서 응답 없음', color: '#DC2626', bg: '#FEE2E2', icon: 'sensors_off' },
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
  const inputHint = el.closest('header')?.querySelector('.game-hud-hint');
  const simulationHint = inputHint?.textContent.trim();
  const render = () => {
    const meta = SENSOR_STATUS_META[SensorService.getStatus()] || SENSOR_STATUS_META.simulation;
    if (inputHint) inputHint.textContent = SensorService.getMode() === 'simulation' ? simulationHint : '센서를 쥐어 조작';
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

// Unified retro toast. opts: { type:'success'|'error'|'info', icon, duration }.
// Reuses .retro-toast. NOTE: page-local showToast declarations (profile/settings) load AFTER
// shared.js and shadow this — intentional, so those pages keep their existing behavior.
function showToast(msg, opts = {}) {
  if (typeof document === 'undefined') return;
  const type = opts.type || 'success';
  const isError = type === 'error';
  const isInfo = type === 'info';
  const icon = opts.icon || (isError ? 'error' : isInfo ? 'info' : 'check_circle');
  const duration = opts.duration || (isError ? 3500 : 2500);

  const t = document.createElement('div');
  t.className = 'retro-toast';
  t.setAttribute('role', isError ? 'alert' : 'status');
  let iconColor = 'var(--primary)';
  if (isError) {
    t.style.borderColor = 'var(--error)';
    t.style.color = 'var(--error)';
    iconColor = 'var(--error)';
  }
  t.innerHTML = `<span class="material-symbols-outlined" style="color:${iconColor};font-variation-settings:'FILL' 1">${icon}</span><span>${msg}</span>`;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// Set the root data-font-size attribute from a settings value ('large'|'xlarge'); clears otherwise.
function applyFontSize(fontSize) {
  if (typeof document === 'undefined') return;
  if (fontSize === 'large' || fontSize === 'xlarge') {
    document.documentElement.dataset.fontSize = fontSize;
  } else {
    delete document.documentElement.dataset.fontSize;
  }
}

// Shared "back" helper: go back within the app when we arrived from a same-origin page,
// otherwise fall back to a known href (direct entry / external referrer / fresh tab).
function goBack(fallbackHref = 'index.html') {
  try {
    const ref = document.referrer;
    if (ref && new URL(ref).origin === location.origin && history.length > 1) {
      history.back();
      return;
    }
  } catch {}
  location.href = fallbackHref;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAME SHELL — common bootstrap / input / pause / result-save-reward for game pages
// ═══════════════════════════════════════════════════════════════════════════════
// Absorbs the ~200 lines every game duplicates. API contract is fixed (Phase-2 games code
// against it). State machine: 'ready' → 'countdown' → 'playing' ⇄ 'paused' → 'ended'.
const GameShell = {
  create(opts = {}) {
    const gameId = opts.gameId;
    const viewportId = opts.viewportId || 'game-viewport';
    const howto = Array.isArray(opts.howto) ? opts.howto : [];
    const onStart = typeof opts.onStart === 'function' ? opts.onStart : () => {};
    const onPauseChange = typeof opts.onPauseChange === 'function' ? opts.onPauseChange : () => {};
    const buildResult = typeof opts.buildResult === 'function' ? opts.buildResult : () => ({});
    const onCleanup = typeof opts.onCleanup === 'function' ? opts.onCleanup : () => {};
    const onReset = typeof opts.onReset === 'function' ? opts.onReset : () => {};

    const cfg = gameConfig(gameId);
    const def = GAME_DEFS[gameId] || { label: '게임' };
    const DIFF_LABEL = { easy: '쉬움', medium: '보통', hard: '어려움' };
    const state = { phase: 'ready' };   // 'ready'|'countdown'|'playing'|'paused'|'ended'

    let sensorBadgeUnsub = null;
    let readyOverlay = null;
    let pauseOverlay = null;
    let rotateOverlay = null;   // 가로 모드 안내 (아래 "화면 방향" 구역 참조)
    let rotateMql = null;
    let rotateMqlHandler = null;
    let rotateTrapKey = null;
    let countdownTimer = null;
    let pressBound = null;
    let saving = false;
    let pauseBtn = null;        // 런타임 주입한 헤더 일시정지 버튼 (게임 HTML 은 수정하지 않는다)
    let pauseBtnClick = null;
    let practiceMode = false, practiceElapsed = 0, practiceOverlay = null;
    let sessionContext = null, sessionOwnerScope = null, readySensorCleanup = null;
    let practiceBadge = null;
    let pauseReason = '';
    const practiceGoal = { balloon: 1, crane: 1, rhythm: 4, glide: 3 }[gameId] || 1;
    const inputReady = () => SensorService.isReady();
    const sameInput = () => !sessionContext || (sessionOwnerScope === DataService._storageScope() &&
      JSON.stringify(SensorService.getSessionContext()) === JSON.stringify(sessionContext));
    const reduced = () => prefersReducedMotion();
    const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // ── create() bootstrap: absorb scattered per-page setup ──
    let settings = {};
    try { settings = DataService.getSettingsSync() || {}; } catch {}
    try { if (settings.reducedMotion) document.documentElement.setAttribute('data-reduced-motion', ''); } catch {}
    try { applyFontSize(settings.fontSize); } catch {}
    try { SensorService.loadCalibration(); } catch {}
    try { injectFeedbackModal(); } catch {}
    try {
      const badge = document.getElementById('sensor-badge');
      if (badge) sensorBadgeUnsub = bindSensorBadge(badge);
    } catch {}

    // ── Ready overlay ──
    function buildReadyOverlay() {
      const howtoHtml = howto.map(h =>
        `<li><span class="material-symbols-outlined">${escHtml(h.icon || 'chevron_right')}</span><span>${escHtml(h.text || '')}</span></li>`
      ).join('');

      const ov = document.createElement('div');
      ov.className = 'game-ready-overlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.setAttribute('aria-label', def.label + ' 준비');
      ov.innerHTML = `
        <div class="game-ready-card">
          <div class="game-ready-head">
            <h2 class="game-ready-title font-display">${escHtml(def.label)}</h2>
            <span class="game-difficulty-chip">${DIFF_LABEL[cfg.difficulty] || '보통'}</span>
          </div>
          <div class="game-ready-status game-sensor-controls"></div>
          <p class="game-input-message" role="status"></p>
          ${howtoHtml ? `<ul class="game-ready-howto">${howtoHtml}</ul>` : ''}
          <div class="game-ready-actions">
            <button type="button" class="btn-retro btn-retro-primary game-ready-start" autofocus>
              <span class="material-symbols-outlined">play_arrow</span>시작하기
            </button>
            <button type="button" class="btn-retro game-ready-practice">20초 연습</button>
            <a class="btn-retro game-ready-exit" href="training.html">나가기</a>
          </div>
        </div>
      `;
      return ov;
    }

    function removeReadyOverlay() {
      if (readySensorCleanup) { readySensorCleanup(); readySensorCleanup = null; }
      if (readyOverlay) { readyOverlay.remove(); readyOverlay = null; }
    }

    function showReadyOverlay() {
      readyOverlay = buildReadyOverlay();
      document.body.appendChild(readyOverlay);
      if (typeof ReGripSensorUI !== 'undefined') readySensorCleanup = ReGripSensorUI.mount(readyOverlay.querySelector('.game-sensor-controls'), { compact: true });
      const startBtn = readyOverlay.querySelector('.game-ready-start');
      if (startBtn) {
        startBtn.addEventListener('click', () => beginCountdown(false));
        requestAnimationFrame(() => startBtn.focus());
      }
      readyOverlay.querySelector('.game-ready-practice').addEventListener('click', () => beginCountdown(true));
      syncInputState();
    }

    function beginCountdown(practice = false) {
      if (state.phase !== 'ready' || !inputReady() || document.hidden) return;
      practiceMode = !!practice;
      practiceElapsed = 0;
      state.phase = 'countdown';
      if (readySensorCleanup) { readySensorCleanup(); readySensorCleanup = null; }
      const card = readyOverlay && readyOverlay.querySelector('.game-ready-card');
      if (!card) { finishCountdown(); return; }
      card.innerHTML = `<div class="game-countdown-num" aria-live="assertive">3</div>`;
      const numEl = card.querySelector('.game-countdown-num');
      let n = 3;
      const step = () => {
        numEl.textContent = String(n);
        if (!reduced()) {
          numEl.classList.remove('countdown-pop');
          void numEl.offsetWidth;   // reflow to retrigger the pop animation
          numEl.classList.add('countdown-pop');
        }
        n--;
        if (n >= 1) countdownTimer = setTimeout(step, 700);
        else countdownTimer = setTimeout(finishCountdown, 700);
      };
      step();
    }

    function finishCountdown() {
      if (!inputReady() || document.hidden) {
        state.phase = 'ready';
        removeReadyOverlay();
        showReadyOverlay();
        return;
      }
      sessionContext = JSON.parse(JSON.stringify(SensorService.getSessionContext()));
      sessionOwnerScope = DataService._storageScope();
      removeReadyOverlay();
      state.phase = 'playing';
      if (practiceMode) {
        practiceBadge = document.createElement('span');
        practiceBadge.className = 'font-display text-xs font-bold';
        practiceBadge.textContent = '연습 · 최대 20초';
        const anchor = document.getElementById('sensor-badge');
        if (anchor && anchor.parentNode) anchor.parentNode.appendChild(practiceBadge);
      }
      syncPauseBtn();
      try { onStart(); } catch (e) { console.warn('[GameShell] onStart 오류:', e && e.message); }
      // 카운트다운(≈2.1s) 중에 화면을 가로로 돌린 경우: 그때는 phase 가 'playing' 이 아니라
      // pause() 가 먹지 않았다. playing 에 들어온 지금 곧바로 멈춰 세운다 —
      // 그러지 않으면 회전 안내 뒤에서 보이지 않는 채로 타이머가 흘러간다.
      if (rotateOverlay) pause();
    }

    function syncInputState() {
      const ready = inputReady();
      if (readyOverlay && state.phase === 'ready') {
        for (const selector of ['.game-ready-start', '.game-ready-practice']) {
          const btn = readyOverlay.querySelector(selector);
          if (btn) btn.disabled = !ready;
        }
        const hint = readyOverlay.querySelector('.game-input-message');
        if (hint) hint.textContent = ready ? '준비 완료 · 연습 기록과 보상은 저장되지 않습니다.' : '센서를 연결하고 보정하거나 시뮬레이션을 선택해 주세요.';
      }
      if (state.phase === 'playing' && (!ready || !sameInput())) pause('sensor');
      if (pauseOverlay) {
        const btn = pauseOverlay.querySelector('.game-pause-resume');
        if (btn) btn.disabled = !ready || !sameInput() || document.hidden;
        const msg = pauseOverlay.querySelector('.game-pause-message');
        if (msg) msg.textContent = !sameInput() ? '계정, 입력 방식 또는 보정이 변경되었습니다. 훈련 화면에서 새 게임을 시작해 주세요.'
          : !ready ? '센서 신호를 기다리고 있습니다. 다시 연결되면 계속할 수 있습니다.'
          : pauseReason === 'sensor' ? '센서가 준비되었습니다. 계속하기를 눌러 재개하세요.'
          : pauseReason === 'timing' ? '화면 처리가 잠시 지연되어 멈췄습니다. 계속하기를 눌러 주세요.' : '준비되면 계속하기를 눌러 주세요.';
        const reconnect = pauseOverlay.querySelector('.game-pause-reconnect');
        if (reconnect) reconnect.hidden = SensorService.getMode() === 'simulation' || ready;
      }
    }
    SensorService.onStatusChange(syncInputState);

    function releaseInput() { if (pressBound) pressBound.up(); }

    // Return true after stopping a practice; page loops must return immediately.
    function progress(dt, completed) {
      if (!practiceMode || state.phase !== 'playing') return false;
      practiceElapsed += dt;
      if (practiceElapsed < 20 && completed < practiceGoal) return false;
      releaseInput();
      state.phase = 'practice-ended';
      if (practiceBadge) { practiceBadge.remove(); practiceBadge = null; }
      onPauseChange(true);
      syncPauseBtn();
      practiceOverlay = document.createElement('div');
      practiceOverlay.className = 'game-ready-overlay';
      practiceOverlay.setAttribute('role', 'dialog');
      practiceOverlay.setAttribute('aria-modal', 'true');
      practiceOverlay.setAttribute('aria-label', '연습 완료');
      practiceOverlay.innerHTML = `<div class="game-ready-card"><h2 class="font-display">연습 완료</h2><p>연습 기록과 보상은 저장되지 않습니다.</p><div class="game-ready-actions"><button class="btn-retro game-practice-repeat">다시 연습</button><button class="btn-retro btn-retro-primary game-practice-main">본게임 시작</button></div></div>`;
      document.body.appendChild(practiceOverlay);
      practiceOverlay.querySelector('.game-practice-repeat').addEventListener('click', () => restart(true));
      const main = practiceOverlay.querySelector('.game-practice-main');
      main.addEventListener('click', () => restart(false));
      requestAnimationFrame(() => main.focus());
      return true;
    }

    function restart(practice) {
      if (state.phase !== 'practice-ended') return;
      if (practiceOverlay) { practiceOverlay.remove(); practiceOverlay = null; }
      releaseInput();
      sessionContext = null;
      sessionOwnerScope = null;
      practiceElapsed = 0;
      onReset();
      state.phase = 'ready';
      showReadyOverlay();
      beginCountdown(practice);
    }

    // ── Input (bindPress) ──
    function bindPress(onDown, onUp) {
      unbindPress();
      const el = document.getElementById(viewportId);
      const isPlaying = () => state.phase === 'playing' && SensorService.getMode() === 'simulation';
      let held = false, pointerId = null;
      const up = () => {
        held = false;
        const releaseId = pointerId;
        pointerId = null;
        if (el && releaseId !== null) { try { el.releasePointerCapture(releaseId); } catch {} }
        if (typeof onUp === 'function') onUp();
      };

      const keydown = (e) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        if (!isPlaying() || e.repeat || held) return;
        e.preventDefault();
        held = true;
        if (typeof onDown === 'function') onDown(e);
      };
      const keyup = (e) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        up();
      };
      document.addEventListener('keydown', keydown);
      document.addEventListener('keyup', keyup);

      const down = (e) => {
        if (!isPlaying() || held || (e.button != null && e.button !== 0)) return;
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('button,a,input,select,textarea')) return;
        if (e.cancelable) e.preventDefault();
        held = true;
        pointerId = e.pointerId;
        if (el) { try { el.setPointerCapture(pointerId); } catch {} }
        if (typeof onDown === 'function') onDown(e);
      };
      if (el) {
        el.addEventListener('pointerdown', down);
        el.addEventListener('lostpointercapture', up);
      }
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
      window.addEventListener('blur', up);
      pressBound = { keydown, keyup, down, up, el };
      return unbindPress;
    }

    function unbindPress() {
      if (!pressBound) return;
      pressBound.up();
      document.removeEventListener('keydown', pressBound.keydown);
      document.removeEventListener('keyup', pressBound.keyup);
      if (pressBound.el) {
        pressBound.el.removeEventListener('pointerdown', pressBound.down);
        pressBound.el.removeEventListener('lostpointercapture', pressBound.up);
      }
      document.removeEventListener('pointerup', pressBound.up);
      document.removeEventListener('pointercancel', pressBound.up);
      window.removeEventListener('blur', pressBound.up);
      pressBound = null;
    }

    // ── Pause / resume / Esc ──
    function pause(reason = '') {
      if (state.phase !== 'playing') return;
      releaseInput();
      pauseReason = reason;
      state.phase = 'paused';
      try { onPauseChange(true); } catch (e) { console.warn('[GameShell] onPauseChange 오류:', e && e.message); }
      showPauseOverlay();
      syncInputState();
      syncPauseBtn();
    }

    function resume() {
      if (state.phase !== 'paused' || !inputReady() || !sameInput() || document.hidden || rotateOverlay) return;
      removePauseOverlay();
      state.phase = 'playing';
      try { onPauseChange(false); } catch (e) { console.warn('[GameShell] onPauseChange 오류:', e && e.message); }
      syncPauseBtn();
      // 오버레이의 '계속하기'로 재개하면 포커스를 잃은 자리가 <body> 로 떨어진다.
      // 방금 다시 보이게 된 헤더 일시정지 버튼으로 옮겨 준다(없거나 숨겨져 있으면 아무것도 하지 않는다).
      if (pauseBtn && pauseBtn.style.display !== 'none' && !pauseBtn.disabled) {
        try { pauseBtn.focus(); } catch {}
      }
    }

    // ── 헤더 일시정지 버튼 (터치 사용자용) ──
    // 지금까지 일시정지는 Escape 키 전용이라 터치 사용자는 '종료 → 확인 모달 → 취소' 우회밖에 없었다.
    // 게임 HTML 은 이 트랙의 소유가 아니므로, 헤더의 안정적인 훅(#exit-btn / #sensor-badge) 옆에
    // 런타임으로 버튼을 끼워 넣는다. 스타일은 #exit-btn 의 인라인 style 을 그대로 복사해 톤을 맞춘다.
    function buildPauseBtn() {
      const anchor = document.getElementById('exit-btn');
      const fallback = anchor ? null : document.getElementById('sensor-badge');
      const host = (anchor && anchor.parentNode) || (fallback && fallback.parentNode);
      if (!host) return;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'game-pause-btn';
      const styleSrc = anchor || fallback;
      btn.className = styleSrc.className;
      // 복사한 색/그림자/블러는 그대로 두고, 아이콘+라벨 정렬용 속성만 덧붙인다.
      // 크기는 절대 강제하지 않는다 → 데스크톱에서 #exit-btn 과 같은 자연 높이를 유지해 헤더 높이가 불변이다.
      // 모바일 터치 타깃(48×48) 은 shared.css 의 @media (max-width:767px) 규칙이 담당한다.
      btn.setAttribute('style', (styleSrc.getAttribute('style') || '')
        + ';display:inline-flex;align-items:center;justify-content:center;gap:4px;');

      pauseBtnClick = () => {
        // paused 에서는 이 버튼이 숨겨져 있다(아래 syncPauseBtn 참조). 재개는 오버레이의 '계속하기' 담당.
        if (state.phase === 'playing') pause();
      };
      btn.addEventListener('click', pauseBtnClick);

      if (anchor) host.insertBefore(btn, anchor);   // 종료 버튼 바로 앞 형제
      else host.appendChild(btn);
      pauseBtn = btn;
      syncPauseBtn();
    }

    // playing 에서만 노출한다. ready(준비 오버레이) / countdown / paused / ended 에서는 숨긴다.
    // paused 를 숨김에 포함하는 이유: 일시정지 오버레이(.game-pause-overlay, position:fixed; inset:0; z-index:245)가
    // 전면을 덮어 이 버튼은 포인터로 누를 수 없는데, 노출된 채로 두면 aria-modal 다이얼로그 바깥에서
    // Tab 으로 도달 가능한 유령 컨트롤이 된다. 재개는 오버레이가 소유한 '계속하기' 버튼이 담당하므로 기능 손실은 없다.
    function syncPauseBtn() {
      if (!pauseBtn) return;
      const usable = state.phase === 'playing';
      pauseBtn.style.display = usable ? 'inline-flex' : 'none';
      pauseBtn.disabled = !usable;
      pauseBtn.setAttribute('aria-hidden', usable ? 'false' : 'true');
      pauseBtn.setAttribute('aria-label', '일시정지');
      pauseBtn.innerHTML =
        `<span class="material-symbols-outlined" style="font-size:18px;">pause</span>일시정지`;
    }

    function removePauseBtn() {
      if (!pauseBtn) return;
      if (pauseBtnClick) { try { pauseBtn.removeEventListener('click', pauseBtnClick); } catch {} }
      try { pauseBtn.remove(); } catch {}
      pauseBtn = null;
      pauseBtnClick = null;
    }

    function showPauseOverlay() {
      if (pauseOverlay) return;
      pauseOverlay = document.createElement('div');
      pauseOverlay.className = 'game-pause-overlay';
      pauseOverlay.setAttribute('role', 'dialog');
      pauseOverlay.setAttribute('aria-modal', 'true');
      pauseOverlay.setAttribute('aria-label', '일시정지');
      pauseOverlay.innerHTML = `
        <div class="game-pause-card">
          <h2 class="font-display">일시정지</h2>
          <p class="game-pause-message" role="status"></p>
          <div class="game-pause-actions">
            <button type="button" class="btn-retro btn-retro-primary game-pause-resume" autofocus>
              <span class="material-symbols-outlined">play_arrow</span>계속하기
            </button>
            <button type="button" class="btn-retro game-pause-reconnect">센서 다시 연결</button>
            <button type="button" class="btn-retro game-pause-quit">
              <span class="material-symbols-outlined">logout</span>그만하기
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(pauseOverlay);
      const resumeBtn = pauseOverlay.querySelector('.game-pause-resume');
      const reconnectBtn = pauseOverlay.querySelector('.game-pause-reconnect');
      if (reconnectBtn) reconnectBtn.addEventListener('click', async () => {
        reconnectBtn.disabled = true;
        try {
          const restored = await SensorService.reconnect();
          if (restored === false && pauseOverlay) pauseOverlay.querySelector('.game-pause-message').textContent = '저장된 센서를 찾지 못했습니다. 설정에서 다시 연결한 뒤 새 게임을 시작해 주세요.';
        } catch (e) {
          if (pauseOverlay) pauseOverlay.querySelector('.game-pause-message').textContent = e.message || '센서를 연결하지 못했습니다. 다시 시도해 주세요.';
        } finally { reconnectBtn.disabled = false; }
      });
      const quitBtn = pauseOverlay.querySelector('.game-pause-quit');
      if (resumeBtn) { resumeBtn.addEventListener('click', resume); requestAnimationFrame(() => resumeBtn.focus()); }
      if (quitBtn) quitBtn.addEventListener('click', confirmExit);
    }

    function removePauseOverlay() {
      if (pauseOverlay) { pauseOverlay.remove(); pauseOverlay = null; }
    }

    // ── 화면 방향 — 세로 전용 (가로 모드는 지원하지 않는다) ──
    // 가로 740×360 실측: 헤더 73 + 상단 HUD 120 + 하단 게이지 92 = 285px 가 먼저 소비돼
    // 스테이지에 75px 밖에 안 남고, 크레인 집게(고정 160px)와 리듬 열기구(132px)가 스테이지
    // 밖으로 완전히 나간다. 악력 유지·정밀 추적은 원래 세로 자세 과제이기도 하다.
    // → 가로에서는 안내를 띄우고 게임을 멈춘다.
    //
    // 감지 조건에 (max-height: 500px) 를 반드시 함께 건다. **데스크톱도 landscape 다** —
    // (orientation: landscape) 만 쓰면 모든 데스크톱 사용자에게 회전 안내가 뜬다.
    // 구별 기준은 폭이 아니라 뷰포트 '높이'다. 실측 폰 가로 568×320 / 640×360 / 740×360 /
    // 667×375 / 736×414 → 높이 320~414px, 데스크톱 1280×800 / 1440×900 / 1920×1080 → 800px 이상.
    // 500px 은 그 사이에서 양쪽 모두와 충분히 떨어진 값이다(폰 최대 414 대비 +86, 데스크톱 최소
    // 800 대비 -300). window.innerWidth 로는 구별할 수 없다 — 폰 가로 폭이 740px 까지 나와
    // 데스크톱과 겹친다.
    const ROTATE_MQ = '(orientation: landscape) and (max-height: 500px)';

    function showRotateOverlay() {
      if (rotateOverlay) return;
      const ov = document.createElement('div');
      ov.className = 'game-rotate-overlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.setAttribute('aria-label', '화면 방향 안내');
      ov.innerHTML = `
        <div class="game-rotate-card" tabindex="-1">
          <span class="material-symbols-outlined game-rotate-icon" aria-hidden="true">screen_rotation</span>
          <h2 class="font-display">화면을 세로로 돌려 주세요</h2>
          <p class="game-rotate-desc">이 훈련은 세로 화면에 맞춰 만들어졌어요. 가로에서는 악력 게이지와 놀이 화면이 다 보이지 않아 잠시 멈춰 둘게요.</p>
        </div>
      `;
      document.body.appendChild(ov);
      rotateOverlay = ov;

      // 오버레이 안에 포커스 가능한 컨트롤이 없다(사용자가 할 일은 기기를 돌리는 것뿐).
      // 컨테이너로 포커스를 옮겨 스크린리더가 제목·본문을 읽게 하고, Tab 이 뒤의 배경 요소로
      // 새지 않도록 캡처 단계에서 가둔다.
      const card = ov.querySelector('.game-rotate-card');
      if (card) requestAnimationFrame(() => { try { card.focus(); } catch {} });
      rotateTrapKey = (e) => {
        if (e.key !== 'Tab' || !rotateOverlay) return;
        e.preventDefault();
        const c = rotateOverlay.querySelector('.game-rotate-card');
        if (c) { try { c.focus(); } catch {} }
      };
      document.addEventListener('keydown', rotateTrapKey, true);
    }

    function removeRotateOverlay() {
      if (rotateTrapKey) {
        try { document.removeEventListener('keydown', rotateTrapKey, true); } catch {}
        rotateTrapKey = null;
      }
      if (rotateOverlay) { rotateOverlay.remove(); rotateOverlay = null; }
    }

    function applyRotateState(isLandscapePhone) {
      if (isLandscapePhone) {
        // pause() 를 먼저 부른다: 일시정지 오버레이가 rAF 로 '계속하기'에 포커스를 주므로,
        // 그 뒤에 회전 카드 포커스를 예약해야 포커스가 안내 쪽에 남는다.
        if (state.phase === 'playing') pause();
        showRotateOverlay();
      } else {
        // 세로로 돌아오면 안내만 걷는다. **자동 재개하지 않는다** — 아래에 일시정지 오버레이의
        // '계속하기'가 남아 있으므로 사용자가 준비됐을 때 직접 재개한다.
        removeRotateOverlay();
        // 포커스가 방금 제거된 회전 카드에 있었으면 <body> 로 떨어진다. 아래에 떠 있는
        // 오버레이의 기본 버튼으로 되돌려 준다.
        const back = (pauseOverlay && pauseOverlay.querySelector('.game-pause-resume'))
                  || (readyOverlay && readyOverlay.querySelector('.game-ready-start'));
        if (back) { try { back.focus(); } catch {} }
      }
    }

    function watchRotate() {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      rotateMql = window.matchMedia(ROTATE_MQ);
      rotateMqlHandler = (e) => applyRotateState(!!e.matches);
      if (typeof rotateMql.addEventListener === 'function') rotateMql.addEventListener('change', rotateMqlHandler);
      else if (typeof rotateMql.addListener === 'function') rotateMql.addListener(rotateMqlHandler);   // 구형 Safari
      applyRotateState(!!rotateMql.matches);   // 가로로 든 채 페이지에 들어온 경우
    }

    function unwatchRotate() {
      if (rotateMql && rotateMqlHandler) {
        if (typeof rotateMql.removeEventListener === 'function') rotateMql.removeEventListener('change', rotateMqlHandler);
        else if (typeof rotateMql.removeListener === 'function') rotateMql.removeListener(rotateMqlHandler);
      }
      rotateMql = null;
      rotateMqlHandler = null;
      removeRotateOverlay();
    }

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Let an open confirm modal own Escape (so cancel keeps the pause overlay).
      if (document.querySelector('.confirm-modal-overlay')) return;
      // 회전 안내가 떠 있는 동안은 Escape 로 재개할 수 없다 — 보이지 않는 화면에서
      // 게임이 다시 굴러가는 것을 막는다.
      if (rotateOverlay) return;
      if (state.phase === 'playing') { e.preventDefault(); pause(); }
      else if (state.phase === 'paused') { e.preventDefault(); resume(); }
    };
    document.addEventListener('keydown', onKey);
    const onVisibility = () => {
      if (document.hidden) { releaseInput(); pause('visibility'); }
      syncInputState();
    };
    document.addEventListener('visibilitychange', onVisibility);

    function confirmExit() {
      if (state.phase === 'playing') pause();
      openConfirmModal({
        title: '게임 종료',
        body: '지금 종료하면 이번 세션은 저장되지 않습니다. 종료할까요?',
        confirmLabel: '종료',
        cancelLabel: '취소',
        danger: true,
        onConfirm: () => { teardown(); if (typeof location !== 'undefined') location.href = 'training.html'; },
      });
      // Cancel intentionally does nothing → the pause overlay stays (user re-confirms 계속하기).
    }

    // ── Teardown (game-specific + shell listeners) ──
    function teardown() {
      clearTimeout(countdownTimer);
      unbindPress();
      removeReadyOverlay();
      removePauseOverlay();
      unwatchRotate();          // matchMedia change 리스너 + Tab 트랩 + 오버레이 DOM 정리
      removePauseBtn();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisibility);
      SensorService.offStatusChange(syncInputState);
      if (practiceOverlay) { practiceOverlay.remove(); practiceOverlay = null; }
      if (practiceBadge) { practiceBadge.remove(); practiceBadge = null; }
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      if (sensorBadgeUnsub) { try { sensorBadgeUnsub(); } catch {} sensorBadgeUnsub = null; }
      try { onCleanup(); } catch (e) { console.warn('[GameShell] onCleanup 오류:', e && e.message); }
    }

    function onPageHide() {
      // Uncompleted session → run the game's own cleanup only; never save (existing policy).
      if (state.phase !== 'ended') { try { onCleanup(); } catch {} }
    }
    if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);

    // ── Result stars (ported from game-balloon.html) ──
    function renderResultStars(stars) {
      const el = document.getElementById('result-stars');
      if (!el) return;
      const rm = reduced();
      el.innerHTML = [1, 2, 3].map(i => {
        const on = i <= stars;
        const cls = rm ? '' : ' star-pop';
        const delay = rm ? '' : `;animation-delay:${(i - 1) * 120}ms`;
        return `<span class="material-symbols-outlined text-3xl${cls} ${on ? 'text-yellow-400' : 'text-on-surface-variant'}"
          style="font-variation-settings:'FILL' ${on ? 1 : 0}${delay}">star</span>`;
      }).join('');
    }

    function renderResultActions() {
      const el = document.getElementById('result-actions');
      if (!el) return;
      el.style.display = '';
      el.innerHTML = `
        <button type="button" class="btn-retro btn-retro-primary game-result-replay">
          <span class="material-symbols-outlined">refresh</span>다시 플레이
        </button>
        <a class="btn-retro game-result-history" href="history.html">
          <span class="material-symbols-outlined">timeline</span>기록 보기
        </a>
      `;
      const replay = el.querySelector('.game-result-replay');
      if (replay) replay.addEventListener('click', () => { if (typeof location !== 'undefined') location.reload(); });
    }

    // Reward view (ported from game-balloon.html showReward). Buttons stay visible — no auto-nav.
    function showReward(res) {
      if (!res) return;
      const rv = document.getElementById('reward-view');
      if (rv) rv.style.display = 'flex';

      const xpEl = document.getElementById('reward-xp');
      if (xpEl) animateCount(xpEl, res.xpAwarded || 0, { duration: 700 });

      if (res.levelUp) {
        const lu = document.getElementById('reward-levelup');
        if (lu) { lu.textContent = `Lv. ${res.level} 달성!`; lu.style.display = 'inline-block'; }
      }

      const chips = Array.isArray(res.unlockedAchievements) ? res.unlockedAchievements : [];
      const achEl = document.getElementById('reward-achievements');
      if (achEl) {
        achEl.innerHTML = chips.map(a => {
          const rs = (typeof RARITY_STYLE !== 'undefined' && RARITY_STYLE[a.rarity]) || { color: '#5E86B8', bg: '#D6E6F2' };
          return `<span class="font-display text-xs font-bold px-3 py-1 rounded-full" style="background:${rs.bg};color:${rs.color};border:2px solid #0F172A;">`
            + `${escHtml(a.title)} +${Number(a.rewardXp) || 0} XP</span>`;
        }).join('');
      }
    }

    async function saveAndReward(result, prevSessions) {
      if (saving) return;
      saving = true;
      let res;
      try { res = await DataService.saveSession(result); } catch (e) { console.warn('[GameShell] saveSession 오류:', e && e.message); res = undefined; }

      const isRest = (typeof DataService.isRest === 'function' && DataService.isRest());
      if (isRest) {
        if (res) {
          showReward(res);                                   // server-confirmed reward
        } else {
          showToast('서버 저장 실패, 로컬에 보관됨', { type: 'error' });
          showReward(GamificationEngine.rewardPreviewFor(prevSessions, result));   // local preview fallback
        }
      } else {
        showReward(GamificationEngine.rewardPreviewFor(prevSessions, result));     // local mode preview
      }
    }

    // ── end(): natural game-over flow (idempotent) ──
    function end() {
      if (state.phase === 'ended') return;
      if (practiceMode) { progress(20, practiceGoal); return; }
      if (state.phase !== 'playing' || !sessionContext) return;
      if (!sameInput()) { pause('sensor'); return; }
      releaseInput();
      // Capture the sessions list BEFORE saving (local reward preview needs the "before" state).
      let prevSessions = [];
      try { prevSessions = DataService._readLocal('regrip_sessions', []) || []; } catch {}

      state.phase = 'ended';
      syncPauseBtn();

      let result = {};
      try { result = buildResult() || {}; } catch (e) { console.warn('[GameShell] buildResult 오류:', e && e.message); result = {}; }
      // Merge shell fields; game-supplied values win.
      result = { ...result, difficulty: result.difficulty || cfg.difficulty, schema: result.schema || 2 };
      result = { ...result, ...JSON.parse(JSON.stringify(sessionContext)) };
      if (cfg.handUsed && !result.handUsed) result.handUsed = cfg.handUsed;

      renderResultStars(result.stars || 0);

      const overlay = document.getElementById('result-overlay');
      if (overlay) {
        overlay.classList.add('open');
        requestAnimationFrame(() => overlay.classList.add('shown'));
      }

      renderResultActions();
      saveAndReward(result, prevSessions);

      requestAnimationFrame(() => {
        const first = document.querySelector('#result-actions button, #result-actions a');
        if (first && typeof first.focus === 'function') first.focus();
      });
    }

    // ── Kick off: 헤더 일시정지 버튼 주입(ready 단계에서는 숨김) 후 준비 오버레이 ──
    try { buildPauseBtn(); } catch (e) { console.warn('[GameShell] 일시정지 버튼 주입 실패:', e && e.message); }
    showReadyOverlay();
    // 화면 방향 감시는 준비 오버레이 **뒤에** 건다. watchRotate() 는 현재 상태를 즉시 반영하는데,
    // 가로로 든 채 들어온 경우 showRotateOverlay() 가 rAF 로 회전 카드에 포커스를 예약한다.
    // 준비 오버레이도 같은 방식으로 '시작하기'에 포커스를 주므로, 뒤에 걸어야 포커스가 안내 쪽에 남는다.
    try { watchRotate(); } catch (e) { console.warn('[GameShell] 화면 방향 감시 실패:', e && e.message); }

    return {
      cfg,
      state,
      get playing() {
        if (state.phase === 'playing' && (!inputReady() || !sameInput())) pause('sensor');
        return state.phase === 'playing';
      },
      isPractice: () => practiceMode,
      progress,
      start: beginCountdown,
      restart,
      bindPress,
      end,
      pause,
      resume,
      confirmExit,
    };
  },
};

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
  const cycle = ['balloon', 'crane', 'rhythm', 'glide'];   // 4-game rotation
  const sessions = [];
  for (let i = 0; i < 14; i++) {
    const gameId = cycle[i % 4];
    const def = GAME_DEFS[gameId];
    const id = now - i * DAY_MS;

    // Plausible per-game score / attempt counts (deterministic via the shared PRNG).
    let sets, attempts;
    if (gameId === 'balloon') {
      sets = 4 + Math.floor(rand() * 9);          // 4–12 pops
      attempts = sets;
    } else if (gameId === 'crane') {
      sets = 2 + Math.floor(rand() * 5);          // 2–6 capsules (reworked pace)
      attempts = sets + Math.floor(rand() * 3);   // sets + 0–2
    } else if (gameId === 'rhythm') {
      attempts = 24;                              // 3 sets × 8 reps
      sets = 12 + Math.floor(rand() * 13);        // 12–24 valid pumps (≤ attempts)
    } else { // glide
      attempts = 30;                             // gate count
      sets = 10 + Math.floor(rand() * 21);        // 10–30 gates cleared
    }

    const avgForce = 45 + Math.floor(rand() * 40);    // 45–84
    const maxForce = Math.min(100, avgForce + 8 + Math.floor(rand() * 20));
    const stars = starsForScore(gameId, sets);
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

    sessions.push({
      id,
      inputSource: 'simulation',
      calibrationSnapshot: null,
      date: new Date(id).toISOString(),
      gameId,
      label: def.label,
      sets,
      attempts,
      avgForce,
      maxForce,
      stars,
      durationSec,
      durationMin,
      setDetails,
      demo: true,
      schema: 2,
    });
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

  // Reduced-motion + font-size preferences from settings → root attributes (shared.css reacts).
  try {
    const settings = DataService.getSettingsSync();
    if (settings && settings.reducedMotion) {
      document.documentElement.setAttribute('data-reduced-motion', '');
    }
    if (settings) applyFontSize(settings.fontSize);
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

  // Offline badge (F3): wire the browser online/offline events once, seed initial state, paint.
  if (!initPage._offlineBound) {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('online',  () => _regripSetOffline(false));
      window.addEventListener('offline', () => _regripSetOffline(true));
    }
    initPage._offlineBound = true;
  }
  _regripOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
  renderOfflineBadge();

  // REST-mode background sync (F1): silent outbox drain, then the one-time migration prompt.
  // Runs after injectNav so the mirror still holds pre-login local sessions (page fetches, which
  // overwrite the mirror with server data, happen after initPage returns).
  if (DataService.isRest() && AuthService.isAuthenticated()) {
    try { resendOutbox(); } catch {}
    try { maybePromptMigration(); } catch {}
  }
}

// ── Node interop (unit testing only; harmless in the browser) ──
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AuthService, DataService, SensorService, GamificationEngine, resendOutbox, _migrateSessions,
    sessionSource, sourceLabel, filterSessionSource, countSessionSources,
    GAME_DEFS, LEGACY_EXERCISE_ICONS, RARITY_STYLE, SENSOR_STATUS_META,
    GAME_TUNING, gameConfig, recommendTraining, intensityFor, GameShell, showToast, seedDemoData,
    gameIdOf, starsForScore, iconForSession, mulberry32, _seedFrom, deriveSetDetails,
    maxConsecutiveDays, dayNum, formatKoreanDate,
  };
}
