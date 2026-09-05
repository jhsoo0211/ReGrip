'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Run the real PowerShell entry point. Only the PlatformIO command boundary is replaced;
// these tests never enumerate/open a device, compile firmware, or flash a board.
function run(options = {}, { localPython = true, commandAvailable = true, commandExit = 0, preflightExit = 0,
  ports = [{ port: 'COM3', description: 'USB UART', hwid: 'USB VID:PID=10C4:EA60' }, { port: 'COM12', description: 'USB UART', hwid: 'USB VID:PID=10C4:EA60' }] } = {}) {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, 'ReGrip flash test '));
  const script = path.join(root, 'scripts', 'flash-sensor.ps1');
  const project = path.join(root, 'firmware', 'esp32-ble-sensor');
  const python = path.join(root, '.tools', 'pio', 'Scripts', 'python.exe');
  const fallback = path.join(root, 'fake pio.exe');
  const log = path.join(root, 'calls.jsonl');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'platformio.ini'), '[env:esp32dev]\n');
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'flash-sensor.ps1'), script);
  if (localPython) { fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, ''); }
  const wrapper = path.join(root, 'test-wrapper.ps1');
  fs.writeFileSync(wrapper, String.raw`
$ErrorActionPreference = 'Stop'
$fake = {
    [IO.File]::AppendAllText($env:REGRIP_TEST_LOG, (ConvertTo-Json -InputObject @($args) -Compress) + [Environment]::NewLine)
    if ($args -contains '--json-output') {
        Write-Output $env:REGRIP_TEST_PORTS
        $global:LASTEXITCODE = [int]$env:REGRIP_TEST_PREFLIGHT_EXIT
    } else { $global:LASTEXITCODE = [int]$env:REGRIP_TEST_EXIT }
}
Set-Item -LiteralPath ('Function:' + $env:REGRIP_TEST_PYTHON) -Value $fake
Set-Item -LiteralPath ('Function:' + $env:REGRIP_TEST_FALLBACK) -Value $fake
function Get-Command {
    [CmdletBinding()]
    param([string]$Name, [object]$CommandType)
    if ($env:REGRIP_TEST_AVAILABLE -eq 'yes') { [pscustomobject]@{ Source = $env:REGRIP_TEST_FALLBACK } }
}
$options = @{}
(ConvertFrom-Json $env:REGRIP_TEST_OPTIONS).PSObject.Properties | ForEach-Object { $options[$_.Name] = $_.Value }
& $env:REGRIP_TEST_SCRIPT @options
exit $LASTEXITCODE
`);
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, REGRIP_TEST_SCRIPT: script, REGRIP_TEST_OPTIONS: JSON.stringify(options), REGRIP_TEST_LOG: log,
        REGRIP_TEST_PYTHON: python, REGRIP_TEST_FALLBACK: fallback, REGRIP_TEST_AVAILABLE: commandAvailable ? 'yes' : 'no', REGRIP_TEST_EXIT: String(commandExit),
        REGRIP_TEST_PORTS: JSON.stringify(ports), REGRIP_TEST_PREFLIGHT_EXIT: String(preflightExit) },
    });
    if (result.error) throw result.error;
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
    return { ...result, calls, project };
  } finally {
    // mkdtemp created this exact child; never delete a caller-provided or computed outside path.
    assert.equal(path.dirname(fs.realpathSync(root)), tempRoot);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const windows = { skip: process.platform !== 'win32' };

test('flash entry point refuses missing, invalid, or conflicting port actions without invoking PlatformIO', windows, () => {
  for (const options of [{}, { Port: 'COM0' }, { Port: 'COM3;whoami' }, { BuildOnly: true, Port: 'COM3' }, { ListPorts: true, Monitor: true }]) {
    const r = run(options); assert.notEqual(r.status, 0, JSON.stringify(options)); assert.equal(r.calls.length, 0);
  }
});
test('build-only uses the project Python and preserves a firmware path containing spaces', windows, () => {
  const r = run({ BuildOnly: true }); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [['-m', 'platformio', 'run', '--project-dir', r.project, '--environment', 'esp32dev']]);
});
test('an explicit port builds and uploads once, with no automatic monitor', windows, () => {
  const r = run({ Port: 'com12' }); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [['-m', 'platformio', 'device', 'list', '--serial', '--json-output'], ['-m', 'platformio', 'run', '--project-dir', r.project, '--environment', 'esp32dev', '--target', 'upload', '--upload-port', 'COM12']]);
});
test('list-ports enumerates only and can use PlatformIO from PATH', windows, () => {
  const r = run({ ListPorts: true }, { localPython: false }); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [['device', 'list', '--serial']]);
});
test('a failed upload propagates the native exit code and never opens a monitor', windows, () => {
  const r = run({ Port: 'COM3', Monitor: true }, { commandExit: 17 });
  assert.equal(r.status, 17, r.stderr); assert.equal(r.calls.length, 2);
});
test('monitor is opened only after a successful explicitly requested upload and monitor', windows, () => {
  const r = run({ Port: 'COM3', Monitor: true }); assert.equal(r.status, 0, r.stderr); assert.equal(r.calls.length, 3);
  assert.deepEqual(r.calls[2], ['-m', 'platformio', 'device', 'monitor', '--project-dir', r.project, '--environment', 'esp32dev', '--port', 'COM3', '--baud', '115200']);
});
test('missing PlatformIO returns a failure without any implicit installation or device access', windows, () => {
  const r = run({ BuildOnly: true }, { localPython: false, commandAvailable: false });
  assert.notEqual(r.status, 0); assert.equal(r.calls.length, 0); assert.match(r.stdout + r.stderr, /\.tools[\\/]pio/);
});
test('a nonexistent port or Bluetooth virtual serial port is rejected before build or upload', windows, () => {
  for (const ports of [[], [{ port: 'COM3', description: 'Standard Bluetooth serial link', hwid: 'BTHENUM\\{00001101-0000-1000-8000-00805F9B34FB}' }]]) {
    const r = run({ Port: 'COM3' }, { ports });
    assert.notEqual(r.status, 0); assert.deepEqual(r.calls, [['-m', 'platformio', 'device', 'list', '--serial', '--json-output']]);
  }
});
test('port enumeration failures propagate their code without attempting an upload', windows, () => {
  const r = run({ Port: 'COM3' }, { preflightExit: 9 });
  assert.equal(r.status, 9); assert.equal(r.calls.length, 1); assert.ok(r.calls[0].includes('--json-output'));
});
