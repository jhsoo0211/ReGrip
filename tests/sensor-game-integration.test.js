'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Synthetic data only. No private capture, recorded subject, COM port, or board is
// needed in CI. The mock ends at GATT notifications; normalization, calibration,
// freshness, the production GameShell, and each page script execute unchanged.
const { createBleGameRuntime, REST_RAW, SQUEEZE_RAW, rawFor } = require('./helpers/ble-game-runtime');
const GAMES = ['balloon', 'crane', 'rhythm', 'glide'];
function setup(game, t) { const h = createBleGameRuntime(game); t.after(() => h.dispose()); return h; }

function assertSavedBle(h, calibration) {
  const externallyRead = h.r.sensor.getSessionContext();
  externallyRead.calibrationSnapshot.baseline0 = 0;
  h.finish();
  assert.equal(h.r.saves.length, 1);
  const result = h.r.saves[0];
  assert.equal(result.inputSource, 'ble');
  assert.deepEqual(JSON.parse(JSON.stringify(result.calibrationSnapshot)), calibration);
  assert.equal(result.calibrationSnapshot.baseline0, REST_RAW);
  assert.ok(result.durationSec > 0);
  assert.ok(result.avgForce >= 0 && result.avgForce <= result.maxForce && result.maxForce <= 100);
  return result;
}

for (const game of GAMES) {
  test(`${game}: real BLE service gates start and maps decreasing FSR, while flex and keyboard cannot supply force`, async t => {
    const h = setup(game, t), { r } = h;
    await r.sensor.connectBle();
    r.start();
    assert.equal(r.run('shell.state.phase'), 'ready', 'A GATT connection without packets is not ready');
    h.emit(REST_RAW);
    r.start();
    assert.equal(r.run('shell.state.phase'), 'ready', 'An uncalibrated live sensor is not ready');
    const calibration = await h.calibrate();
    assert.equal(r.sensor.isReady(), true);
    assert.equal(r.sensor.getForce(), 0);
    await h.start();

    r.document.emit('keydown', { code: 'Space' });
    await h.feed(500, REST_RAW, elapsed => elapsed % 100 ? 4095 : 0);
    r.document.emit('keyup', { code: 'Space' });
    assert.equal(r.sensor.getForce(), 0);
    assert.equal(r.run('gripForce'), 0);
    assert.equal(r.run('score'), 0);
    assert.equal(r.sensor.getRawSample().flexRaw, 4095, 'The diagnostic channel still receives data');

    await h.tick(SQUEEZE_RAW);
    const firstFiltered = r.sensor.getForce();
    assert.ok(firstFiltered > 46 && firstFiltered < 47, '50ms through the actual 80ms filter must not jump to 100%');
    assert.equal(r.run('gripForce'), firstFiltered);
    if (game === 'glide') assert.equal(parseFloat(r.elements.get('sub-wrap').style.bottom), firstFiltered);
    await h.feed(800, SQUEEZE_RAW);
    assert.ok(r.sensor.getForce() > 99.9 && r.sensor.getForce() <= 100);
    await h.feed(1200, REST_RAW);
    assert.ok(r.sensor.getForce() >= 0 && r.sensor.getForce() < 0.001);
    assert.equal(r.run('gripForce'), r.sensor.getForce());
    assertSavedBle(h, calibration);
  });

  test(`${game}: invalid and duplicate BLE packets cannot prevent 500ms stale, award score, or auto-resume`, async t => {
    const h = setup(game, t), { r } = h;
    await h.connect(); await h.calibrate(); await h.start();
    await h.tick(SQUEEZE_RAW);
    const lastTimestamp = r.sensor.getRawSample().timestampMs;
    const invalid = [h.lastCsv(), `${lastTimestamp + 1},1,1,300`, `${lastTimestamp + 2},4096,300`, `${lastTimestamp - 1},0,300`];
    for (let i = 0; i < 9; i++) await h.invalidTick(invalid[i % invalid.length]);
    assert.equal(r.sensor.getStatus(), 'connected');
    await h.invalidTick(invalid[1]);
    assert.equal(r.sensor.getStatus(), 'stale');
    assert.equal(r.sensor.isReady(), false);
    assert.equal(r.sensor.getMode(), 'ble');
    assert.equal(r.run('shell.state.phase'), 'paused');
    const gameClock = game === 'glide' ? 'elapsed' : 'gameElapsed';
    const pausedAt = r.run(gameClock);
    for (let i = 0; i < 20; i++) await h.invalidTick(invalid[i % invalid.length]);
    assert.equal(r.run(gameClock), pausedAt);
    assert.equal(r.run('score'), 0);
    assert.equal(r.saves.length, 0);
    r.run('shell.resume()');
    assert.equal(r.run('shell.state.phase'), 'paused');
    await h.tick(REST_RAW);
    assert.equal(r.sensor.isReady(), true);
    assert.equal(r.run('shell.state.phase'), 'paused', 'Fresh packets alone must not resume the game');
    r.run('shell.resume()');
    await h.tick(REST_RAW);
    assert.equal(r.run('shell.state.phase'), 'playing');
    assert.ok(Math.abs(r.run(gameClock) - pausedAt - 0.05) < 1e-9);
  });
}

test('balloon: calibrated raw pressure raises and holds a balloon to an actual pop', async t => {
  const h = setup('balloon', t), { r } = h;
  await h.connect(); const calibration = await h.calibrate(); await h.start();
  for (let i = 0; i < 200 && r.run('balloonPct') < 73; i++) await h.tick(SQUEEZE_RAW);
  assert.ok(r.run('balloonPct') >= 73 && r.run('balloonPct') < 85);
  await h.feed(3500, rawFor(60));
  assert.equal(r.run('score'), 1);
  assert.equal(assertSavedBle(h, calibration).sets, 1);
});

test('crane: calibrated raw pressure completes grab, hold, carry, and deliberate release', async t => {
  const h = setup('crane', t), { r } = h;
  await h.connect(); const calibration = await h.calibrate(); await h.start();
  for (let i = 0; i < 400 && r.run('phase') !== 'DROPZONE'; i++) await h.tick(SQUEEZE_RAW);
  assert.equal(r.run('phase'), 'DROPZONE');
  assert.equal(r.run('score'), 0, 'Carrying alone must not award a capsule');
  await h.feed(250, REST_RAW);
  assert.equal(r.run('score'), 1);
  assert.equal(assertSavedBle(h, calibration).sets, 1);
});

test('rhythm: actual filtered FSR edges can hit four cues with intervening release', async t => {
  const h = setup('rhythm', t), { r } = h;
  await h.connect(); const calibration = await h.calibrate(); await h.start();
  for (let cue = 0; cue < 4; cue++) {
    const arrival = r.run(`cues[${cue}].arrival`);
    while (r.run('setClock') < arrival - 100) await h.tick(REST_RAW);
    await h.feed(200, SQUEEZE_RAW);
    assert.equal(r.run('score'), cue + 1);
    await h.feed(500, REST_RAW);
    assert.ok(r.run('gripForce') < r.run('REL'));
  }
  assert.equal(r.run('setValidForces.length'), 4);
  assert.equal(assertSavedBle(h, calibration).sets, 4);
});

test('glide: actual filtered FSR drives both the visible submarine and three successful gates', async t => {
  const h = setup('glide', t), { r } = h;
  await h.connect(); const calibration = await h.calibrate(); await h.start();
  while (r.run('elapsed') < 9.05) {
    // Read the generated scene as a player would; feed raw ADC only. Neither
    // submarine position, timing, score, nor gate judgement is assigned here.
    await h.tick(rawFor(r.run('targetAt(elapsed + 0.05)')));
    assert.equal(parseFloat(r.elements.get('sub-wrap').style.bottom), r.sensor.getForce());
  }
  assert.equal(r.run('judged'), 3);
  assert.equal(r.run('score'), 3);
  assert.equal(assertSavedBle(h, calibration).sets, 3);
});

test('a new actual BLE calibration during pause blocks resuming or saving the old session', async t => {
  const h = setup('balloon', t), { r } = h;
  await h.connect(); await h.calibrate(); await h.start();
  await h.feed(200, SQUEEZE_RAW);
  r.run('shell.pause()');
  const rest = await h.capture(REST_RAW), squeeze = await h.capture(600);
  r.sensor.saveBleCalibration(rest, squeeze);
  r.run('shell.resume()');
  assert.equal(r.run('shell.state.phase'), 'paused');
  r.run('shell.end()');
  assert.equal(r.saves.length, 0, 'A session must not mix two calibration snapshots');
});
