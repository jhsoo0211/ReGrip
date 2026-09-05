#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseSensorCsv, resampleSegment } = require('./sensor-csv.cjs');
const { createBleGameRuntime } = require('../tests/helpers/ble-game-runtime');

const GAMES = ['balloon', 'crane', 'rhythm', 'glide'];
const HELP = `Replay a USB sensor CSV through the production sensor service and game scripts.
No device, browser storage, API request, or XP write is performed.

node scripts/replay-sensor.cjs --file <capture.csv> --rest <ADC> --grip <ADC> [--game all|balloon|crane|rhythm|glide]

Both calibration endpoints must be integer ADC test assumptions, not a saved user calibration.
Accepts sample_id,timestamp_ms,flex_raw,fsr_raw or timestamp_ms,flex_raw,fsr_raw.
Each device restart starts an independent scenario; packets are replayed at 20 Hz.
`;

function parseArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return null;
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--file', '--rest', '--grip', '--game'].includes(flag) || !args[i + 1]?.trim() || values[flag] !== undefined) {
      throw new Error(`Unknown, duplicate, or missing argument: ${flag}`);
    }
    values[flag] = args[i + 1];
  }
  if (!values['--file'] || !values['--rest'] || !values['--grip']) throw new Error('--file, --rest, and --grip are required.');
  const rest = Number(values['--rest']), grip = Number(values['--grip']);
  if (![rest, grip].every(v => Number.isInteger(v) && v >= 0 && v <= 4095) || Math.abs(rest - grip) < 64) {
    throw new Error('Calibration assumptions must be integer ADC 0..4095 with an absolute span of at least 64.');
  }
  const game = values['--game'] || 'all';
  if (game !== 'all' && !GAMES.includes(game)) throw new Error(`Unknown game: ${game}`);
  return { file: values['--file'], rest, grip, games: game === 'all' ? GAMES : [game] };
}

async function replaySegment(game, segment, { rest, grip }) {
  const h = createBleGameRuntime(game, { baseline0: rest, baseline100: grip });
  const frames = resampleSegment(segment, 50);
  let delivered = 0, minForce = Infinity, maxForce = -Infinity, replayedMs = 0;
  try {
    await h.connect();
    await h.calibrate();
    await h.start();
    // Reset the transport timestamp after synthetic calibration/countdown samples.
    // Each reset in a capture has its own game and in-memory persistence boundary.
    await h.sensor.reconnect();
    h.notifyRaw(frames[0].sample);
    h.r.run('shell.resume()');
    for (let elapsed = 0; elapsed <= segment.durationMs; elapsed += 50) {
      if (elapsed > 0) await h.clock.advance(50);
      if (delivered < frames.length && frames[delivered].atMs <= elapsed) {
        // First sample already seeded the connection; do not send a duplicate.
        if (delivered > 0) h.notifyRaw(frames[delivered].sample);
        delivered++;
      }
      h.r.frame();
      replayedMs = elapsed;
      const force = h.sensor.getForce();
      minForce = Math.min(minForce, force); maxForce = Math.max(maxForce, force);
      // A capture cannot supply the user's manual resume decision. Stop at that
      // boundary (or game completion), also bounding arbitrarily long log gaps.
      if (h.r.run('shell.state.phase') !== 'playing') break;
    }
    const phase = h.r.run('shell.state.phase'), score = h.r.run('score');
    h.finish();
    return {
      game, segment: segment.index, captureDurationMs: segment.durationMs,
      deliveredPackets: delivered, forceRange: [minForce, maxForce].map(v => Math.round(v * 100) / 100),
      score, phaseBeforeFinish: phase, replayedMs,
      remainingCaptureMs: Math.max(0, segment.durationMs - replayedMs),
      // Only an in-memory observer receives the production result. Nothing is uploaded.
      observedResult: h.r.saves[0] || null,
    };
  } finally { h.dispose(); }
}

async function main(args) {
  const options = parseArgs(args);
  if (!options) return process.stdout.write(HELP);
  const parsed = parseSensorCsv(fs.readFileSync(options.file, 'utf8'));
  if (!parsed.segments.length) throw new Error('No valid sensor samples found.');
  const scenarios = [];
  for (const segment of parsed.segments) {
    for (const game of options.games) scenarios.push(await replaySegment(game, segment, options));
  }
  process.stdout.write(JSON.stringify({
    mode: 'diagnostic-replay', physicalDevice: false, persistentWrites: false,
    file: path.basename(options.file), calibrationAssumption: { rest: options.rest, grip: options.grip },
    capture: parsed.summary, scenarios,
  }, null, 2) + '\n');
  // Still show diagnostics when malformed rows exist, but flag a failed capture check.
  if (parsed.invalidRows.length) process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.message}\n${HELP}`); process.exitCode = 1;
});
module.exports = { parseArgs, replaySegment };
