const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// DOM and transport boundaries are mocked; the production shell and page scripts run unchanged.
function runtime(game, settings = {}) {
  let now = 10000, id = 0, ready = true, force = 0, ownerScope = 'local';
  let context = { inputSource: 'simulation', calibrationSnapshot: null };
  const scheduled = new Map(), timers = new Map(), saves = [], status = [], forceListeners = [];
  class Element {
    constructor() { this.style = { setProperty() {} }; this.children = []; this.listeners = {}; this.attrs = {}; this._html = ''; this.selectors = new Map(); this.clientWidth = 800; this.clientHeight = 600; this.disabled = false; this.textContent = ''; this.parentNode = null; this.classes = new Set(); this.classList = { add: (...v) => v.forEach(x => this.classes.add(x)), remove: (...v) => v.forEach(x => this.classes.delete(x)), contains: x => this.classes.has(x), toggle: (x,b) => b ? this.classes.add(x) : this.classes.delete(x) }; }
    set innerHTML(v) { this._html = v; this.selectors.clear(); this.children = []; }
    get innerHTML() { return this._html; }
    setAttribute(k,v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k] || ''; }
    appendChild(e) { e.parentNode = this; this.children.push(e); return e; }
    insertBefore(e) { return this.appendChild(e); }
    addEventListener(k,f) { (this.listeners[k] ||= new Set()).add(f); }
    removeEventListener(k,f) { this.listeners[k]?.delete(f); }
    emit(k, extra={}) { for (const f of [...(this.listeners[k] || [])]) f({code:'', key:'', preventDefault(){}, cancelable:true, target:this, ...extra}); }
    querySelector(s) { if (!this.selectors.has(s)) this.selectors.set(s,new Element()); return this.selectors.get(s); }
    querySelectorAll() { return []; }
    focus() {} remove() { if (this.parentNode) this.parentNode.children=this.parentNode.children.filter(x=>x!==this); }
    getBoundingClientRect() { return {left:0,top:0,width:50,height:50}; }
    setPointerCapture() {} releasePointerCapture() {}
  }
  const document = new Element(), window = new Element(), elements = new Map();
  document.body = new Element(); document.documentElement = new Element(); document.hidden = false;
  document.createElement = document.createElementNS = () => new Element();
  document.getElementById = name => { if (!elements.has(name)) { const e=new Element(); document.body.appendChild(e); elements.set(name,e); } return elements.get(name); };
  document.querySelector = s => s === '.confirm-modal-overlay' ? null : document.body.querySelector(s);
  window.matchMedia = () => ({matches:false,addEventListener(){},removeEventListener(){}});
  const sensor = {
    isReady:()=>ready, getStatus:()=>ready?'connected':'stale', getMode:()=>context.inputSource==='simulation'?'simulation':'ble',
    getForce:()=>force, getSessionContext:()=>structuredClone(context), loadCalibration:async()=>{},
    onStatusChange:f=>status.push(f), offStatusChange:f=>{const i=status.indexOf(f); if(i>=0)status.splice(i,1)},
    onForceUpdate:f=>forceListeners.push(f),offForceUpdate(){},setSimulatedForce(v){force=v;forceListeners.forEach(f=>f(v));},
  };
  const data = {_storageScope:()=>ownerScope,getSettingsSync:()=>settings,getProfileSync:()=>({goalForce:80}),_readLocal:()=>[],saveSession:r=>{saves.push(r);return Promise.resolve({})},isRest:()=>false};
  const sandbox = {document,window,SensorService:sensor,DataService:data,console,Date:class extends Date{static now(){return now}},performance:{now:()=>now},Math,URLSearchParams,structuredClone,
    requestAnimationFrame:f=>{scheduled.set(++id,f);return id},cancelAnimationFrame:n=>scheduled.delete(n),setTimeout:f=>{timers.set(++id,f);return id},clearTimeout:n=>timers.delete(n),setInterval:()=>++id,clearInterval(){},
    prefersReducedMotion:()=>true,applyFontSize(){},injectFeedbackModal(){},bindSensorBadge:()=>()=>{},animateCount(){},showToast(){},openConfirmModal(){},GamificationEngine:{rewardPreviewFor:()=>({})},ReGripSensorUI:{mount:()=>()=>{}},location:{href:'',reload(){}},
  };
  const ctx=vm.createContext(sandbox), shared=fs.readFileSync(path.join(root,'shared.js'),'utf8');
  vm.runInContext(shared.slice(shared.indexOf('const GAME_DEFS ='),shared.indexOf('// Suggest the next training game.')),ctx);
  vm.runInContext(shared.slice(shared.indexOf('const GameShell ='),shared.indexOf('// DEMO SEEDING')),ctx);
  // seeded path helper is a pure dependency of the glide page.
  vm.runInContext('function mulberry32(a){return function(){let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;}}',ctx);
  if(game) { const html=fs.readFileSync(path.join(root,`game-${game}.html`),'utf8'); const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1]; vm.runInContext(script,ctx); }
  else vm.runInContext('let presses=0; const shell=GameShell.create({gameId:"balloon",onStart(){},buildResult:()=>({sets:1})});shell.bindPress(()=>presses++,()=>presses=0);',ctx);
  const run = s => vm.runInContext(s,ctx);
  const flushTimers = () => { for(let n=0;n<5&&timers.size;n++){const q=[...timers.values()];timers.clear();q.forEach(f=>f());} };
  const start = practice => { run(`shell.start(${!!practice})`); flushTimers(); };
  const step = (seconds, hz=50) => {for(let i=0;i<Math.ceil(seconds*hz);i++){now+=1000/hz;const q=[...scheduled.values()];scheduled.clear();q.forEach(f=>f(now));}};
  return {run,start,step,document,window,elements,saves,setOwner(v){ownerScope=v},setReady(v){ready=v;status.forEach(f=>f(sensor.getStatus()))},setContext(v){context=v;status.forEach(f=>f(sensor.getStatus()))},force(v){force=v;forceListeners.forEach(f=>f(v));},setNow(v){now=v},sensor};
}

test('unset difficulty is easy but explicit medium and legacy normal are retained',()=>{
  assert.equal(runtime().run('gameConfig("balloon").difficulty'),'easy');
  assert.equal(runtime(null,{difficulty:'medium'}).run('gameConfig("balloon").difficulty'),'medium');
  assert.equal(runtime(null,{difficulty:'normal'}).run('gameConfig("balloon").difficulty'),'medium');
});
test('stale pauses, requires fresh data and manual resume, releases simulation key',()=>{
  const r=runtime();r.start();r.document.emit('keydown',{code:'Space'});assert.equal(r.run('presses'),1);
  r.setReady(false);assert.equal(r.run('shell.state.phase'),'paused');assert.equal(r.run('presses'),0);
  r.run('shell.resume()');assert.equal(r.run('shell.state.phase'),'paused');r.setReady(true);assert.equal(r.run('shell.state.phase'),'paused');r.run('shell.resume()');assert.equal(r.run('shell.state.phase'),'playing');
});
test('pointer cancel and hidden tab release input; hidden tab does not resume automatically',()=>{
  const r=runtime();r.start();const vp=r.elements.get('game-viewport');vp.emit('pointerdown',{pointerId:1});assert.equal(r.run('presses'),1);r.document.emit('pointercancel');assert.equal(r.run('presses'),0);r.document.emit('keydown',{code:'Space'});r.document.hidden=true;r.document.emit('visibilitychange');assert.equal(r.run('presses'),0);assert.equal(r.run('shell.state.phase'),'paused');
});
test('practice completion and retry never save; main context is frozen',()=>{
  const r=runtime('balloon');r.start(true);r.run('shell.progress(20,0)');assert.equal(r.run('shell.state.phase'),'practice-ended');assert.equal(r.saves.length,0);
  r.run('shell.restart(false)');r.start(false);r.run('score=2; gameElapsed=2; endGame()');assert.equal(r.saves.length,1);assert.equal(r.saves[0].inputSource,'simulation');assert.equal(r.saves[0].sets,2);
});
test('balloon easy band stabilizes actual position and pause excludes duration',()=>{
  const r=runtime('balloon');r.start();r.run('balloonPct=75; gripForce=70; pressActive=false');r.setContext({inputSource:'ble',calibrationSnapshot:{id:'a'}}); // switching mode must block this session
  assert.equal(r.run('shell.state.phase'),'paused');
  const x=runtime('balloon');x.setContext({inputSource:'ble',calibrationSnapshot:{id:'a'}});x.start();x.run('balloonPct=75');x.force(70);x.step(1);assert.equal(x.run('balloonPct'),75);x.run('shell.pause()');x.step(30);x.run('shell.resume()');x.step(1);assert.equal(Math.round(x.run('gameElapsed')),2);
});
test('crane rejects timeout auto-success and does not count low-force grace as grip',()=>{
  const r=runtime('crane');r.setContext({inputSource:'ble',calibrationSnapshot:{id:'a'}});r.start();r.run('phase="GRIP";holdTime=2.98;graceTimer=0');r.force(0);r.step(.04);assert.equal(r.run('holdTime'),2.98);assert.equal(r.run('score'),0);
  r.run('phase="CARRY";carriedColor="#fff";handleTimeUp()');assert.equal(r.run('score'),0);
});
test('glide visible force and judgement consume same filtered sample',()=>{
  const r=runtime('glide');r.setContext({inputSource:'ble',calibrationSnapshot:{id:'a'}});r.start();r.force(40);r.run('renderSub(.02)');assert.equal(r.elements.get('sub-wrap').style.bottom,'40%');
});
test('rhythm practice stops after four cues and retry resets all scoring',()=>{
  const r=runtime('rhythm');r.start(true);r.step(12);assert.equal(r.run('shell.state.phase'),'practice-ended');assert.equal(r.saves.length,0);r.run('shell.restart(false)');assert.equal(r.run('score'),0);assert.equal(r.run('judgedCount'),0);assert.equal(r.run('setDetails.length'),0);
});

for (const game of ['balloon','crane','glide','rhythm']) {
  test(`${game}: 20 second practice ends without reward; restart gives clean main state`,()=>{
    const r=runtime(game);r.start(true);r.step(21);
    assert.equal(r.run('shell.state.phase'),'practice-ended');assert.equal(r.saves.length,0);
    r.run('shell.restart(false)');r.start(false);
    assert.equal(r.run('score'),0);assert.equal(r.run('shell.isPractice()'),false);
    assert.equal(r.run(game==='glide'?'elapsed':'gameElapsed'),0);
    if (game==='glide') assert.equal(r.run('judged'),0);
    if (game==='crane') assert.equal(r.run('attempts'),0);
    if (game==='rhythm') assert.equal(r.run('judgedCount'),0);
  });
  test(`${game}: active clock does not slow at 10 FPS and excludes pause/hidden time`,()=>{
    const r=runtime(game);r.start();r.step(1,10);
    const clock=game==='glide'?'elapsed':'gameElapsed';
    assert.equal(Math.round(r.run(clock)),1);r.run('shell.pause()');r.step(30);r.run('shell.resume()');r.step(1,10);
    assert.equal(Math.round(r.run(clock)),2);r.document.hidden=true;r.document.emit('visibilitychange');r.step(30);r.document.hidden=false;r.document.emit('visibilitychange');
    assert.equal(r.run('shell.state.phase'),'paused');r.run('shell.resume()');r.step(1,10);assert.equal(Math.round(r.run(clock)),3);
  });
}
test('completed main session saves the start calibration snapshot',()=>{
  const r=runtime('crane'), original={inputSource:'ble',calibrationSnapshot:{version:2,baseline0:200,baseline100:2500}};
  r.setContext(original);r.start();r.step(2);r.run('handleTimeUp()');assert.equal(r.saves.length,1);assert.equal(r.saves[0].durationSec,2);assert.deepEqual(JSON.parse(JSON.stringify(r.saves[0].calibrationSnapshot)),original.calibrationSnapshot);
});
test('readiness gates start before calibration; changing calibration blocks resume',()=>{
  const r=runtime();r.setReady(false);r.start();assert.equal(r.run('shell.state.phase'),'ready');r.setReady(true);r.start();r.setContext({inputSource:'ble',calibrationSnapshot:{id:'different'}});r.run('shell.resume()');assert.equal(r.run('shell.state.phase'),'paused');
});

for (const inputSource of ['simulation', 'ble']) {
  test(`${inputSource}: changing the account or API before completion prevents a cross-owner save`,()=>{
    const r=runtime('balloon');r.setOwner('rest:api-A:user-A');
    r.setContext({inputSource,calibrationSnapshot:inputSource==='ble'?{id:'start-calibration'}:null});r.start();
    r.setOwner(inputSource==='ble'?'rest:api-B:user-A':'rest:api-A:user-B');
    r.run('shell.end()');assert.equal(r.run('shell.state.phase'),'paused');assert.equal(r.saves.length,0);
    r.run('shell.resume()');assert.equal(r.run('shell.state.phase'),'paused');
  });
}

for (const game of ['balloon', 'crane']) {
  test(`${game}: one second of real held force is credited at 10 FPS`, () => {
    const r = runtime(game);
    r.setContext({ inputSource: 'ble', calibrationSnapshot: { id: 'held-input' } });
    r.start();
    r.run(game === 'balloon' ? 'balloonPct=75;holdTime=0' : 'phase="GRIP";holdTime=0');
    r.force(70); r.step(1, 10);
    assert.ok(Math.abs(r.run('holdTime') - 1) < 1e-9);
    assert.ok(Math.abs(r.run('gameElapsed') - 1) < 1e-9);
  });
}

test('crane low-force grace expires in real time at 10 FPS', () => {
  const r = runtime('crane');
  r.setContext({ inputSource: 'ble', calibrationSnapshot: { id: 'held-input' } });
  r.start(); r.run('phase="GRIP";holdTime=0;graceTimer=0'); r.force(0); r.step(0.6, 10);
  assert.notEqual(r.run('phase'), 'GRIP');
  assert.equal(r.run('holdTime'), 0);
});

for (const game of ['balloon', 'crane', 'glide', 'rhythm']) {
  test(`${game}: simulation force keeps its per-second ramp at 5 FPS`, () => {
    const r = runtime(game); r.start(); r.document.emit('keydown', { code: 'Space' }); r.step(1, 5);
    assert.ok(Math.abs(r.run('gripForce') - 55) < 1e-9);
  });

  test(`${game}: a blocked animation frame pauses without adding imagined play time`, () => {
    const r = runtime(game); r.start(); r.document.emit('keydown', { code: 'Space' }); r.step(1, 1);
    const clock = game === 'glide' ? 'elapsed' : 'gameElapsed';
    assert.equal(r.run('shell.state.phase'), 'paused');
    assert.equal(r.run(clock), 0); assert.equal(r.run('score'), 0);
    r.run('shell.resume()'); r.step(0.2, 5);
    assert.ok(Math.abs(r.run(clock) - 0.2) < 1e-9);
    assert.equal(r.run('pressActive'), false);
  });
}

test('rhythm commits a valid squeeze when paused before release so the next squeeze cannot erase it', () => {
  const r = runtime('rhythm');
  r.setContext({ inputSource: 'ble', calibrationSnapshot: { id: 'held-input' } });
  r.start(); r.force(80);
  r.run('sqActive=true;sqWasValid=true;sqStart=0;sqPeak=80;setClock=1000;releasedSinceValid=false;prevForce=80;score=1');
  r.run('shell.pause()'); r.force(0); r.run('shell.resume()'); r.step(0.02);
  assert.equal(r.run('sqActive'), false);
  assert.equal(r.run('setValidForces.length'), 1);
  assert.equal(r.run('setHoldSecs[0]'), 1);
  r.force(80); r.step(0.02); r.force(0); r.step(0.02);
  assert.equal(r.run('setValidForces.length'), 1);
  assert.equal(r.run('score'), 1);
});
