'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBlePacket } = require('../sensor-service.js');
const { parseSensorCsv, resampleSegment, createReplayCursor } = require('../scripts/sensor-csv.cjs');

test('BOM, CRLF, headers, blanks, ESP32 banners and diagnostics are metadata', () => {
  const result = parseSensorCsv('\uFEFFsample_id,timestamp_ms,flex_raw,fsr_raw\r\n\r\nets Jul 29 2019 12:21:46\r\n' +
    'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)\r\nconfigsip: 0, SPIWP:0xee\r\n' +
    'clk_drv:0x00,q_drv:0x00\r\nmode:DIO, clock div:1\r\nload:0x40078000,len:16560\r\n' +
    'ho 0 tail 12 room 4\r\nentry 0x400805b4\r\n# BLE disconnected\r\n0,40,100,200\r\n1,60,101,201\r\n');
  assert.equal(result.format, 'serial4');
  assert.deepEqual(result.summary, { totalLines: 13, validRows: 2, acceptedRows: 2, invalidRows: 0,
    metadataRows: 11, duplicateRows: 0, segmentCount: 1, timestampWraps: 0 });
  assert.deepEqual(result.metadata.map(x => x.kind), ['header','blank','boot','boot','boot','boot','boot','boot','boot','boot','diagnostic']);
  assert.deepEqual(result.segments[0].samples.map(x => x.elapsedMs), [0,20]);
  assert.equal(result.segments[0].samples[0].lineNumber, 12);
});

test('three-column and four-column logs reuse the live BLE packet contract', () => {
  const result = parseSensorCsv('timestamp_ms,flex_raw,fsr_raw\n10,4095,0\n1,30,2,4095');
  assert.equal(result.format, 'mixed');
  assert.deepEqual(result.segments[0].samples.map(s => s.sampleId), [null,1]);
  for (const s of result.segments[0].samples) assert.deepEqual(parseBlePacket(s.packet), {
    timestampMs: s.timestampMs, flexRaw: s.flexRaw, fsrRaw: s.fsrRaw,
  });
});

test('bad numbers, missing/extra columns and out-of-range ADC are invalid, never metadata', () => {
  const rows = ['0,20,1,2', '-1,40,1,2', '1.5,40,1,2', '4294967296,40,1,2',
    '1,40,4096,2', '1,40,1,-2', '1,NaN,1,2', '1,40,Infinity,2', '1,40,1.2,2',
    '1,4294967296,1,2', '1,40,1,', '1,40,1,2,3', 'nonsense', '40,1', '40, 1,2'];
  const result = parseSensorCsv(rows.join('\n'));
  assert.equal(result.summary.acceptedRows, 1);
  assert.equal(result.summary.invalidRows, rows.length - 1);
  assert.equal(result.summary.metadataRows, 0);
  assert.equal(result.invalidRows[0].reason, 'sample-id');
  assert.equal(result.invalidRows.at(-1).reason, 'packet');
});

test('ordinary timestamp and sample-id regressions start independent clocks', () => {
  const result = parseSensorCsv('10,1000,1,2\n11,1020,1,2\n12,10,1,2\n1,30,1,2\n0,0,1,2');
  assert.deepEqual(result.segments.map(s => s.reason), ['start','timestamp-reset','sample-id-reset','timestamp-and-sample-id-reset']);
  assert.deepEqual(result.segments.map(s => s.samples.map(x => x.elapsedMs)), [[0,20],[0],[0],[0]]);
  assert.equal(result.summary.acceptedRows, 5);
});

test('a boot banner splits the recording even when reset counters look like a wrap', () => {
  const result = parseSensorCsv('4294967290,10,20\nets Jul 29 2019 12:21:46\n5,11,21');
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[1].reason, 'boot');
  assert.equal(result.summary.timestampWraps, 0);
});

test('uint32 timestamp and sample-id wraps remain in one segment with unwrapped elapsed time', () => {
  const result = parseSensorCsv('4294967294,4294967280,1,2\n4294967295,4,1,2\n0,24,1,2\n1,44,1,2');
  assert.equal(result.segments.length, 1);
  assert.deepEqual(result.segments[0].samples.map(s => s.elapsedMs), [0,20,40,60]);
  assert.equal(result.summary.timestampWraps, 1);
  assert.equal(result.anomalies.filter(a => a.kind === 'sample-id-wrap').length, 1);
});

test('duplicate timestamps and IDs are reported once per row and excluded from replay samples', () => {
  const result = parseSensorCsv('1,20,1,2\n1,20,1,2\n2,20,9,9\n1,40,3,4\n2,60,5,6');
  assert.equal(result.summary.validRows, 5);
  assert.equal(result.summary.duplicateRows, 3);
  assert.equal(result.summary.acceptedRows, 2);
  assert.deepEqual(result.segments[0].samples.map(s => s.timestampMs), [20,60]);
  assert.equal(result.anomalies.filter(a => a.kind.startsWith('duplicate-')).length, 4);
});

test('sample-id continuity survives intervening three-column rows', () => {
  const result = parseSensorCsv('5,20,1,2\n40,1,2\n4,60,1,2');
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[1].reason, 'sample-id-reset');
});

test('50Hz logs select the latest preceding sample on each 20Hz host deadline', () => {
  const input = Array.from({length:11}, (_,i) => `${i},${1000+i*20},${i},${i+10}`).join('\n');
  const segment = parseSensorCsv(input).segments[0];
  const before = JSON.stringify(segment);
  const frames = resampleSegment(segment);
  assert.deepEqual(frames.map(f => f.atMs), [0,50,100,150,200]);
  assert.deepEqual(frames.map(f => f.sample.sampleId), [0,2,5,7,10]);
  assert.deepEqual(frames.map(f => f.sampleAgeMs), [0,10,0,10,0]);
  assert.equal(JSON.stringify(segment), before);
});

test('20ms and 30ms sample ages are allowed without extrapolation or repeated packets', () => {
  const segment = parseSensorCsv('0,1,1\n20,2,2\n80,3,3\n160,4,4').segments[0];
  const frames = resampleSegment(segment);
  assert.deepEqual(frames.map(f => f.atMs), [0,50,100]);
  assert.deepEqual(frames.map(f => f.sampleAgeMs), [0,30,20]);
  assert.equal(new Set(frames.map(f => f.packet)).size, frames.length);
});

test('resampling each reset segment restarts its host deadline at zero', () => {
  const result = parseSensorCsv('1,100,1,2\n2,150,1,2\n0,10,1,2\n1,60,1,2');
  assert.deepEqual(result.segments.map(s => resampleSegment(s).map(f => f.atMs)), [[0,50],[0,50]]);
});

test('large gaps are skipped without generating a catch-up timeline or stale repeats', () => {
  const segment = parseSensorCsv('0,1,1\n1000000000,2,2').segments[0];
  assert.deepEqual(resampleSegment(segment).map(f => f.atMs), [0,1000000000]);
});

test('a delayed host cursor returns only the latest due frame, never a catch-up burst', () => {
  const segment = parseSensorCsv(Array.from({length:16}, (_,i) => `${i*20},${i},1`).join('\n')).segments[0];
  const cursor = createReplayCursor(resampleSegment(segment));
  assert.equal(cursor.next(0).atMs, 0);
  assert.equal(cursor.next(175).atMs, 150);
  assert.equal(cursor.next(175), null);
  assert.equal(cursor.next(176), null);
  assert.equal(cursor.next(210).atMs, 200);
  assert.equal(cursor.next(1000).atMs, 300);
  assert.equal(cursor.done, true);
  assert.equal(cursor.next(1001), null);
  assert.throws(() => cursor.next(100), RangeError);
});

test('empty input and invalid API arguments have explicit behavior', () => {
  assert.equal(parseSensorCsv('').summary.totalLines, 0);
  assert.deepEqual(parseSensorCsv('').segments, []);
  assert.equal(parseSensorCsv('\n').summary.metadataRows, 1);
  assert.deepEqual(resampleSegment({samples:[]}), []);
  assert.equal(createReplayCursor([]).done, true);
  assert.throws(() => parseSensorCsv(null), TypeError);
  for (const interval of [0,-1,NaN,Infinity]) assert.throws(() => resampleSegment({samples:[]},interval), RangeError);
  assert.throws(() => resampleSegment({samples:[{elapsedMs:1}]}), RangeError);
  assert.throws(() => createReplayCursor([{atMs:0},{atMs:0}]), RangeError);
});
