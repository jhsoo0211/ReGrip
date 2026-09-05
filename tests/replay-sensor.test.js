'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, replaySegment } = require('../scripts/replay-sensor.cjs');
const { parseSensorCsv } = require('../scripts/sensor-csv.cjs');

test('replay requires explicit valid calibration assumptions and a known game', () => {
  assert.equal(parseArgs(['--help']), null);
  const args = ['--file', 'capture with spaces.csv', '--rest', '4095', '--grip', '300'];
  assert.equal(parseArgs(args).games.length, 4);
  assert.equal(parseArgs([...args, '--game', 'balloon']).file, 'capture with spaces.csv');
  assert.throws(() => parseArgs(['--file','x','--rest',' ','--grip','300']));
  for (const invalid of [[], args.slice(0, 4), [...args, '--game', 'bad'], [...args, '--rest', '0'], ['--file','x','--rest','4095','--grip','4090'], ['--file','x','--rest','4095','--grip','300.5'], ['--file','x','--rest','4094.5','--grip','300']]) {
    assert.throws(() => parseArgs(invalid));
  }
});

test('serial capture drives the real filtered game pipeline and only observes an in-memory result', async () => {
  const csv = Array.from({length:101}, (_,i) => `${i},${1000+i*20},${i%2?4095:0},${i<20?4095:300}`).join('\n');
  const segment = parseSensorCsv(csv).segments[0];
  const result = await replaySegment('balloon', segment, {rest:4095,grip:300});
  assert.equal(result.deliveredPackets, 41);
  assert.equal(result.replayedMs, 2000);
  assert.deepEqual(result.forceRange, [0,100]);
  assert.equal(result.phaseBeforeFinish, 'playing');
  assert.equal(result.observedResult.inputSource, 'ble');
  assert.equal(result.observedResult.calibrationSnapshot.baseline100, 300);
});

test('replay stops at a missing-input pause instead of bridging a long capture gap', async () => {
  const segment = parseSensorCsv('0,4095,4095\n1000000000,4095,300').segments[0];
  const result = await replaySegment('balloon', segment, {rest:4095,grip:300});
  assert.equal(result.phaseBeforeFinish, 'paused');
  assert.equal(result.replayedMs, 500);
  assert.equal(result.deliveredPackets, 1);
  assert.equal(result.score, 0);
  assert.ok(result.remainingCaptureMs > 0);
});
