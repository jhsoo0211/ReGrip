'use strict';

const { parseBlePacket } = require('../sensor-service.js');
const UINT32_MAX = 0xffffffff;
const UINT32_SIZE = 0x100000000;
const HALF_UINT32 = 0x80000000;
const HEADERS = new Map([
  ['sample_id,timestamp_ms,flex_raw,fsr_raw', 'serial4'],
  ['timestamp_ms,flex_raw,fsr_raw', 'ble3'],
]);
// Known ESP32 ROM/bootloader lines only; an arbitrary malformed CSV is not metadata.
const BOOT_LINE = /^(?:ets\s+|ESP-ROM:|rst:|configsip:|clk_drv:|mode:|load:|entry\s+0x|ho\s+\d+\s+tail\s+\d+\s+room\s+\d+|Saved PC:|boot:|waiting for download)/i;

function counterStep(previous, current) {
  if (current === previous) return { kind: 'duplicate', delta: 0 };
  if (current > previous) return { kind: 'forward', delta: current - previous };
  const delta = UINT32_SIZE - previous + current;
  return delta < HALF_UINT32 ? { kind: 'wrap', delta } : { kind: 'reset', delta: 0 };
}

/** Parse firmware serial logs without I/O or inference about calibration/physical force.
 * validRows includes duplicate numeric rows; acceptedRows excludes them.
 * Segments carry independent elapsedMs clocks. Both unsigned firmware counters may wrap.
 */
function parseSensorCsv(text) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be a string');
  const lines = text ? text.split(/\r\n|\n|\r/) : [];
  if (lines.at(-1) === '') lines.pop(); // a terminating newline is not an extra record
  const segments = [], metadata = [], invalidRows = [], anomalies = [], formats = new Set();
  let validRows = 0, acceptedRows = 0, duplicateRows = 0, timestampWraps = 0;
  let segment = null, previous = null, previousId = null, bootPending = false;

  lines.forEach((original, index) => {
    const lineNumber = index + 1, line = original.replace(/^\uFEFF/, '').trim();
    const header = HEADERS.get(line.split(',').map(s => s.trim().toLowerCase()).join(','));
    const kind = !line ? 'blank' : header ? 'header' : line.startsWith('#') ? 'diagnostic' : BOOT_LINE.test(line) ? 'boot' : null;
    if (kind) {
      metadata.push({ lineNumber, kind, text: line });
      if (header) formats.add(header);
      if (kind === 'boot' && segment) bootPending = true;
      return;
    }

    const fields = line.split(',');
    let reason = null, sampleId = null, packet = null;
    if (fields.length !== 3 && fields.length !== 4) reason = 'column-count';
    else {
      if (fields.length === 4) {
        if (!/^\d{1,10}$/.test(fields[0]) || Number(fields[0]) > UINT32_MAX) reason = 'sample-id';
        else sampleId = Number(fields[0]);
      }
      const wire = fields.slice(-3).join(',');
      packet = parseBlePacket(wire); // same strict timestamp/ADC contract as live BLE
      if (!packet && !reason) reason = 'packet';
    }
    if (reason) { invalidRows.push({ lineNumber, reason, text: line }); return; }
    validRows++;
    formats.add(fields.length === 4 ? 'serial4' : 'ble3');

    const timeStep = previous ? counterStep(previous.timestampMs, packet.timestampMs) : null;
    const idStep = sampleId !== null && previousId !== null ? counterStep(previousId, sampleId) : null;
    const timeReset = timeStep?.kind === 'reset', idReset = idStep?.kind === 'reset';
    const reset = bootPending || timeReset || idReset;
    if (reset) {
      if (bootPending) anomalies.push({ lineNumber, kind: 'boot-restart' });
      if (timeReset) anomalies.push({ lineNumber, kind: 'timestamp-reset' });
      if (idReset) anomalies.push({ lineNumber, kind: 'sample-id-reset' });
    } else if (timeStep?.kind === 'duplicate' || idStep?.kind === 'duplicate') {
      duplicateRows++;
      if (timeStep?.kind === 'duplicate') anomalies.push({ lineNumber, kind: 'duplicate-timestamp' });
      if (idStep?.kind === 'duplicate') anomalies.push({ lineNumber, kind: 'duplicate-sample-id' });
      return;
    }

    if (!segment || reset) {
      const reason = !segment ? 'start' : bootPending ? 'boot' : timeReset && idReset ? 'timestamp-and-sample-id-reset' : timeReset ? 'timestamp-reset' : 'sample-id-reset';
      segment = { index: segments.length, reason, startLine: lineNumber, endLine: lineNumber, durationMs: 0, samples: [] };
      segments.push(segment);
      previous = null;
      previousId = null;
      bootPending = false;
    } else {
      if (timeStep?.kind === 'wrap') { timestampWraps++; anomalies.push({ lineNumber, kind: 'timestamp-wrap' }); }
      if (idStep?.kind === 'wrap') anomalies.push({ lineNumber, kind: 'sample-id-wrap' });
    }

    const elapsedMs = previous ? previous.elapsedMs + timeStep.delta : 0;
    const sample = { lineNumber, sampleId, ...packet, elapsedMs,
      packet: `${packet.timestampMs},${packet.flexRaw},${packet.fsrRaw}` };
    segment.samples.push(sample);
    segment.endLine = lineNumber;
    segment.durationMs = elapsedMs;
    previous = sample;
    if (sampleId !== null) previousId = sampleId;
    acceptedRows++;
  });

  return {
    format: formats.size > 1 ? 'mixed' : [...formats][0] || null,
    segments, metadata, invalidRows, anomalies,
    summary: { totalLines: lines.length, validRows, acceptedRows, invalidRows: invalidRows.length,
      metadataRows: metadata.length, duplicateRows, segmentCount: segments.length, timestampWraps },
  };
}

/** Build segment-relative host deadlines. No interpolation, averaging, repeated packets,
 * or extrapolation beyond the log. Complexity follows samples, not the duration of gaps.
 * A sample 20/30 ms old at a 50 ms tick is valid; it need not land exactly on the tick.
 */
function resampleSegment(segment, intervalMs = 50) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be finite and positive');
  if (!segment || !Array.isArray(segment.samples)) throw new TypeError('segment.samples must be an array');
  const samples = segment.samples, frames = [];
  if (!samples.length) return frames;
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i];
    if (!Number.isFinite(current.elapsedMs) || current.elapsedMs < 0 ||
        (i === 0 && current.elapsedMs !== 0) || (i > 0 && current.elapsedMs <= samples[i - 1].elapsedMs)) {
      throw new RangeError('samples must start at zero and have strictly increasing elapsedMs');
    }
  }
  const durationMs = samples.at(-1).elapsedMs;
  samples.forEach((sample, i) => {
    const atMs = Math.ceil(sample.elapsedMs / intervalMs) * intervalMs;
    if (atMs > durationMs || (samples[i + 1] && samples[i + 1].elapsedMs <= atMs)) return;
    frames.push({ atMs, sampleAgeMs: atMs - sample.elapsedMs, sample, packet: sample.packet });
  });
  return frames;
}

/** Call next(performance.now() - startedAt) from the host timer. A delayed host tick
 * returns only its latest due frame and discards missed deadlines, never a catch-up burst.
 * Construct a fresh cursor for each segment; its sensor timestamps are not stitched.
 */
function createReplayCursor(frames) {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  frames.forEach((frame, i) => {
    if (!Number.isFinite(frame.atMs) || frame.atMs < 0 || (i && frame.atMs <= frames[i - 1].atMs)) {
      throw new RangeError('frame deadlines must be finite and strictly increasing');
    }
  });
  let nextIndex = 0, lastElapsed = -Infinity;
  return {
    next(elapsedMs) {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs < lastElapsed) throw new RangeError('host elapsedMs must be finite and monotonic');
      lastElapsed = elapsedMs;
      let selected = null;
      while (nextIndex < frames.length && frames[nextIndex].atMs <= elapsedMs) selected = frames[nextIndex++];
      return selected;
    },
    get done() { return nextIndex >= frames.length; },
  };
}

module.exports = { parseSensorCsv, resampleSegment, createReplayCursor };
