const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./helpers/game-runtime');

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
