<#
.SYNOPSIS
Build or upload the ReGrip ESP32 BLE firmware, using an explicitly selected COM port.
.EXAMPLE
.\scripts\flash-sensor.ps1 -ListPorts
.EXAMPLE
.\scripts\flash-sensor.ps1 -BuildOnly
.EXAMPLE
.\scripts\flash-sensor.ps1 -Port COM7
.EXAMPLE
.\scripts\flash-sensor.ps1 -Port COM7 -Monitor
#>
[CmdletBinding(DefaultParameterSetName = 'Upload')]
param(
    [Parameter(ParameterSetName = 'Upload')]
    [ValidatePattern('(?i)^COM[1-9][0-9]*$')]
    [string]$Port,

    [Parameter(Mandatory = $true, ParameterSetName = 'List')]
    [switch]$ListPorts,

    [Parameter(Mandatory = $true, ParameterSetName = 'Build')]
    [switch]$BuildOnly,

    [Parameter(ParameterSetName = 'Upload')]
    [switch]$Monitor
)

$ErrorActionPreference = 'Stop'
# Inspect native exit codes ourselves, including in PowerShell 7.3+.
$PSNativeCommandUseErrorActionPreference = $false

if (-not $ListPorts -and -not $BuildOnly -and -not $Port) {
    Write-Host '[sensor] Choose -ListPorts, -BuildOnly, or -Port COM7 (replace COM7 with your ESP32 port).'
    exit 2
}

try {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $firmwareDir = Join-Path $repoRoot 'firmware\esp32-ble-sensor'
    if (-not (Test-Path -LiteralPath (Join-Path $firmwareDir 'platformio.ini') -PathType Leaf)) {
        throw "Firmware project not found: $firmwareDir"
    }

    $projectPython = Join-Path $repoRoot '.tools\pio\Scripts\python.exe'
    $prefix = @()
    if (Test-Path -LiteralPath $projectPython -PathType Leaf) {
        $runner = $projectPython
        $prefix = @('-m', 'platformio')
    } else {
        $command = Get-Command pio -CommandType Application -ErrorAction SilentlyContinue
        if (-not $command) { $command = Get-Command platformio -CommandType Application -ErrorAction SilentlyContinue }
        if (-not $command) {
            throw 'PlatformIO is missing. From the repository root: py -3.11 -m venv .tools\pio; then .\.tools\pio\Scripts\python.exe -m pip install platformio==6.1.19. See firmware/esp32-ble-sensor/README.md.'
        }
        $runner = $command.Source
    }

    if ($ListPorts) {
        $invokeArgs = $prefix + @('device', 'list', '--serial')
        & $runner @invokeArgs
        exit $LASTEXITCODE
    }

    $invokeArgs = $prefix + @('run', '--project-dir', $firmwareDir, '--environment', 'esp32dev')
    if ($BuildOnly) {
        Write-Host '[sensor] Building ESP32 BLE firmware. No device will be opened.'
    } else {
        $Port = $Port.ToUpperInvariant()
        $listArgs = $prefix + @('device', 'list', '--serial', '--json-output')
        $portJson = & $runner @listArgs
        $commandExit = $LASTEXITCODE
        if ($commandExit -ne 0) {
            Write-Host "[sensor] Could not list serial ports (exit $commandExit)."
            exit $commandExit
        }
        # Windows PowerShell emits a JSON array as one pipeline object. Wrapping
        # that command in @() nests the device list and mixes every port's identity.
        $ports = ConvertFrom-Json -InputObject ($portJson -join [Environment]::NewLine)
        $selected = @($ports | Where-Object { $_.port -eq $Port })
        if ($selected.Count -ne 1) {
            throw "Port $Port was not found uniquely. Connect the ESP32 by USB and run -ListPorts again."
        }
        $identity = [string]$selected[0].hwid + ' ' + [string]$selected[0].description
        if ($identity -match 'BTHENUM|Bluetooth|\uBE14\uB8E8\uD22C\uC2A4') {
            throw "Port $Port is a Bluetooth virtual serial port. Select the ESP32 USB-UART port instead."
        }
        Write-Host "[sensor] Building and uploading ESP32 BLE firmware to $Port."
        $invokeArgs += @('--target', 'upload', '--upload-port', $Port)
    }

    & $runner @invokeArgs
    $commandExit = $LASTEXITCODE
    if ($commandExit -ne 0) {
        Write-Host "[sensor] PlatformIO failed (exit $commandExit)."
        exit $commandExit
    }

    if ($Monitor) {
        Write-Host '[sensor] Opening the requested serial monitor at 115200 baud. Ctrl+C exits.'
        $invokeArgs = $prefix + @('device', 'monitor', '--project-dir', $firmwareDir, '--environment', 'esp32dev', '--port', $Port, '--baud', '115200')
        & $runner @invokeArgs
        exit $LASTEXITCODE
    }
    Write-Host $(if ($BuildOnly) { '[sensor] Build complete.' } else { '[sensor] Upload complete. Connect to ReGrip-Sensor from the browser calibration page.' })
    exit 0
} catch {
    Write-Host ('[sensor] ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
