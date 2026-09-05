'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

// DOM and transport boundaries are mocked; the production shell and page scripts run unchanged.
function runtime(game, settings = {}, options = {}) {
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
  const mockSensor = {
    isReady:()=>ready, getStatus:()=>ready?'connected':'stale', getMode:()=>context.inputSource==='simulation'?'simulation':'ble',
    getForce:()=>force, getSessionContext:()=>structuredClone(context), loadCalibration:async()=>{},
    onStatusChange:f=>status.push(f), offStatusChange:f=>{const i=status.indexOf(f); if(i>=0)status.splice(i,1)},
    onForceUpdate:f=>forceListeners.push(f),offForceUpdate(){},setSimulatedForce(v){force=v;forceListeners.forEach(f=>f(v));},
  };
  const data = {_storageScope:()=>ownerScope,getSettingsSync:()=>settings,getProfileSync:()=>({goalForce:80}),_readLocal:()=>[],saveSession:r=>{saves.push(r);return Promise.resolve({})},isRest:()=>false};
  const readTime = options.clock ? options.clock.now : () => now;
  const sensor = options.createSensor ? options.createSensor({ data, now: readTime }) : mockSensor;
  const math = Object.create(Math);
  if (options.random) math.random = options.random;
  const sandbox = {document,window,SensorService:sensor,DataService:data,console,Date:class extends Date{static now(){return readTime()}},performance:{now:readTime},Math:math,URLSearchParams,structuredClone,
    requestAnimationFrame:f=>{scheduled.set(++id,f);return id},cancelAnimationFrame:n=>scheduled.delete(n),setTimeout:options.clock ? options.clock.setTimeout : f=>{timers.set(++id,f);return id},clearTimeout:options.clock ? options.clock.clearTimeout : n=>timers.delete(n),setInterval:()=>++id,clearInterval(){},
    prefersReducedMotion:()=>true,applyFontSize(){},injectFeedbackModal(){},bindSensorBadge:()=>()=>{},animateCount(){},showToast(){},openConfirmModal(){},GamificationEngine:{rewardPreviewFor:()=>({})},ReGripSensorUI:{mount:()=>()=>{}},location:{href:'',reload(){}},
  };
  const ctx=vm.createContext(sandbox), shared=fs.readFileSync(path.join(root,'shared.js'),'utf8');
  vm.runInContext(shared.slice(shared.indexOf('const GAME_DEFS ='),shared.indexOf('// Suggest the next training game.')),ctx);
  vm.runInContext(shared.slice(shared.indexOf('const GameShell ='),shared.indexOf('// DEMO SEEDING')),ctx);
  // Load the production seeded path helper, rather than duplicating its algorithm.
  vm.runInContext(shared.slice(shared.indexOf('function mulberry32('), shared.indexOf('// Derive a 32-bit unsigned seed')),ctx);
  if(game) { const html=fs.readFileSync(path.join(root,`game-${game}.html`),'utf8'); const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1]; vm.runInContext(script,ctx); }
  else vm.runInContext('let presses=0; const shell=GameShell.create({gameId:"balloon",onStart(){},buildResult:()=>({sets:1})});shell.bindPress(()=>presses++,()=>presses=0);',ctx);
  const run = s => vm.runInContext(s,ctx);
  const flushTimers = () => { for(let n=0;n<5&&timers.size;n++){const q=[...timers.values()];timers.clear();q.forEach(f=>f());} };
  const start = practice => { run(`shell.start(${!!practice})`); flushTimers(); };
  const frame = () => { const q=[...scheduled.values()];scheduled.clear();q.forEach(f=>f(readTime())); };
  const step = (seconds, hz=50) => {
    if (options.clock) throw new Error('Advance the injected clock, then call frame().');
    for(let i=0;i<Math.ceil(seconds*hz);i++){now+=1000/hz;frame();}
  };
  return {run,start,step,frame,document,window,elements,saves,setOwner(v){ownerScope=v},setReady(v){ready=v;status.forEach(f=>f(sensor.getStatus()))},setContext(v){context=v;status.forEach(f=>f(sensor.getStatus()))},force(v){force=v;forceListeners.forEach(f=>f(v));},setNow(v){now=v},sensor};
}


module.exports = { runtime };
