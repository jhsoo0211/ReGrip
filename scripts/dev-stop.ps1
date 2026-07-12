# ReGrip dev 통합 종료 (Windows / PowerShell)
#
# dev-start.ps1 이 기록한 PID 파일을 우선 사용하고, 없거나 부족하면
# 포트 8000/3000 리스너를 폴백으로 찾아 종료한다.
# (uvicorn 은 프로세스 트리째 taskkill /T 로 정리한다.)
#
# 사용:
#   .\scripts\dev-stop.ps1
#   .\scripts\dev-stop.ps1 -BackendPort 8000 -FrontendPort 3000

param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 3000
)

$ErrorActionPreference = "Continue"
$PidFile = Join-Path $PSScriptRoot ".dev-pids.json"
$killed = @()

function Get-PortPids([int]$Port) {
    try {
        @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
    } catch { @() }
}

# ---- 1) PID 파일 기반 종료 ----
if (Test-Path $PidFile) {
    $saved = Get-Content $PidFile -Raw | ConvertFrom-Json
    if ($saved.backendPort)  { $BackendPort  = [int]$saved.backendPort }
    if ($saved.frontendPort) { $FrontendPort = [int]$saved.frontendPort }
    foreach ($name in "backend", "frontend") {
        $procId = $saved.$name
        if ($procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
            taskkill /PID $procId /T /F 2>$null | Out-Null
            $killed += "$name (PID $procId)"
        }
    }
    Remove-Item $PidFile -Force -Confirm:$false
}

# ---- 2) 포트 기반 폴백 (잔존 프로세스 정리) ----
foreach ($port in $BackendPort, $FrontendPort) {
    foreach ($procId in (Get-PortPids $port)) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($null -eq $proc) { continue }
        # 안전장치: 개발 서버로 볼 수 있는 프로세스만 종료 (무관한 앱 보호)
        if ($proc.ProcessName -match "^(python|py|node|cmd|npm)") {
            taskkill /PID $procId /T /F 2>$null | Out-Null
            $killed += "포트 $port ($($proc.ProcessName), PID $procId)"
        } else {
            Write-Host "[dev-stop] 포트 $port 점유 PID $procId ($($proc.ProcessName)) 는 python/node 가 아니라 건너뜁니다."
        }
    }
}

if ($killed.Count -gt 0) {
    Write-Host "[dev-stop] 종료됨: $($killed -join ', ')"
} else {
    Write-Host "[dev-stop] 실행 중인 dev 프로세스가 없습니다."
}

# ---- 3) 포트 해제 확인 ----
Start-Sleep -Seconds 1
foreach ($port in $BackendPort, $FrontendPort) {
    $left = Get-PortPids $port
    if ($left.Count -gt 0) {
        Write-Host "[주의] 포트 $port 가 아직 점유 중입니다 (PID: $($left -join ', '))."
    } else {
        Write-Host "[dev-stop] 포트 $port 해제 확인."
    }
}
