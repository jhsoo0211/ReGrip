# ReGrip dev 통합 시작 (Windows / PowerShell)
#
# 백엔드(FastAPI, uvicorn, 포트 8000)와 프론트(정적 파일 서버, 포트 3000)를
# 각각 백그라운드에서 실행하고, 백엔드 /health 가 준비될 때까지 기다린다.
#
# 사용:
#   .\scripts\dev-start.ps1              # 기본
#   .\scripts\dev-start.ps1 -Force       # 포트 점유 프로세스를 종료하고 진행
#   .\scripts\dev-start.ps1 -NoBrowser   # 브라우저 자동 열기 생략
#   .\scripts\dev-start.ps1 -LocalOnly   # 백엔드 없이 프론트만(로컬 저장 모드) 띄우기
#
# 중요(방금 통합 검증에서 확정):
#   - 프론트는 반드시 http://localhost:3000 으로 접속한다. 백엔드 CORS 화이트리스트에
#     localhost:3000 이 있고, refresh 쿠키가 SameSite=Strict 라 프론트·백엔드의
#     호스트명이 같아야(둘 다 localhost) 로그인이 유지된다.
#   - 백엔드는 backend\venv 파이썬으로 backend\ 에서 실행한다.
# 종료: .\scripts\dev-stop.ps1

param(
    [switch]$Force,
    [switch]$NoBrowser,
    [switch]$LocalOnly,
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 3000,
    [int]$HealthTimeoutSec = 60
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PidFile  = Join-Path $PSScriptRoot ".dev-pids.json"

function Get-PortPids([int]$Port) {
    try {
        @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
    } catch { @() }
}

# ---- 0) 프론트 파이썬(정적 서버용) 결정: py -3.11 우선, 없으면 python ----
$FrontPython = "py"
$FrontPyArgs = @("-3.11")
if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
    $FrontPython = "python"; $FrontPyArgs = @()
}

# Use the verified project interpreter when available for the static server too.
$ProjectPython = Join-Path $RepoRoot "backend\venv\Scripts\python.exe"
if (Test-Path -LiteralPath $ProjectPython) { $FrontPython = $ProjectPython; $FrontPyArgs = @() }

# ---- 1) 포트 선점 검사 ----
$ports = if ($LocalOnly) { @($FrontendPort) } else { @($BackendPort, $FrontendPort) }
foreach ($port in $ports) {
    $occupied = Get-PortPids $port
    if ($occupied.Count -gt 0) {
        if ($Force) {
            foreach ($p in $occupied) { taskkill /PID $p /T /F 2>$null | Out-Null }
            Write-Host "[dev-start] 포트 $port 점유 프로세스 종료 (PID: $($occupied -join ', '))"
        } else {
            Write-Host "[dev-start] 포트 $port 가 이미 사용 중입니다 (PID: $($occupied -join ', '))."
            Write-Host "            .\scripts\dev-stop.ps1 로 정리하거나 -Force 를 사용하세요."
            exit 1
        }
    }
}

$backendId = $null

if (-not $LocalOnly) {
    # ---- 2) 백엔드 기동 (backend\ 에서 backend\venv 파이썬) ----
    $BackendDir = Join-Path $RepoRoot "backend"
    $Python = Join-Path $BackendDir "venv\Scripts\python.exe"
    if (-not (Test-Path $Python)) {
        Write-Host "[오류] backend\venv 가 없습니다. 먼저 가상환경을 만드세요:"
        Write-Host "       cd backend; py -3.11 -m venv venv; .\venv\Scripts\pip install -r requirements.txt"
        exit 1
    }
    Write-Host "[dev-start] 백엔드 기동 중... (uvicorn src.main:app --port $BackendPort)"
    $backend = Start-Process -FilePath $Python `
        -ArgumentList "-X", "utf8", "-m", "uvicorn", "src.main:app", "--port", "$BackendPort" `
        -WorkingDirectory $BackendDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot "backend.log") -RedirectStandardError (Join-Path $PSScriptRoot "backend-error.log") -PassThru
    $backendId = $backend.Id

    # ---- 3) /health 폴링 ----
    $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($backend.HasExited) {
            Write-Host "[오류] 백엔드 프로세스가 기동 중 종료됐습니다 — scripts/backend.log와 backend-error.log를 확인하세요."
            Write-Host "       (자주 겪는 원인: 모델 변경 후 개발 DB 스키마 드리프트 → DB를 삭제하지 말고 백업 후 scripts.upgrade_sqlite 실행, backend\README.md 참고)"
            exit 1
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$BackendPort/health" -TimeoutSec 3
            if ($health.status -eq "ok") { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 700
    }
    if (-not $ready) {
        Write-Host "[오류] $HealthTimeoutSec 초 안에 /health 가 준비되지 않았습니다. scripts/backend-error.log를 확인하세요."
        exit 1
    }
    Write-Host "[dev-start] 백엔드 준비 완료 (http://127.0.0.1:$BackendPort/health = ok)"
}

# ---- 4) 프론트 기동 (정적 파일 서버, 127.0.0.1 바인딩) ----
Write-Host "[dev-start] 프론트 기동 중... (정적 서버, 포트 $FrontendPort)"
$frontArgs = $FrontPyArgs + @("-X", "utf8", "-m", "http.server", "$FrontendPort", "--bind", "127.0.0.1", "--directory", $RepoRoot)
$frontend = Start-Process -FilePath $FrontPython -ArgumentList $frontArgs -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot "frontend.log") -RedirectStandardError (Join-Path $PSScriptRoot "frontend-error.log") -PassThru

# ---- 5) PID 기록 (dev-stop 이 사용) ----
@{
    backend      = $backendId
    frontend     = $frontend.Id
    backendPort  = $BackendPort
    frontendPort = $FrontendPort
    started      = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
} | ConvertTo-Json | Out-File -FilePath $PidFile -Encoding utf8

# ---- 6) 프론트 응답 대기 ----
$frontUp = $false
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    try {
        Invoke-WebRequest -Uri "http://localhost:$FrontendPort/index.html" -TimeoutSec 3 -UseBasicParsing | Out-Null
        $frontUp = $true; break
    } catch { Start-Sleep -Milliseconds 500 }
}

Write-Host ""
Write-Host "=========================================="
Write-Host " ReGrip dev 환경 기동 완료"
if (-not $LocalOnly) {
    Write-Host "  백엔드  : http://127.0.0.1:$BackendPort  (docs: /docs, PID $backendId)"
}
Write-Host "  프론트  : http://localhost:$FrontendPort  (PID $($frontend.Id))$(if (-not $frontUp) { '  [아직 준비 중일 수 있음]' })"
if ($LocalOnly) {
    Write-Host "  모드    : 로컬 저장(서버 미연결). 서버를 쓰려면 -LocalOnly 없이 다시 실행하세요."
} else {
    Write-Host "  로그인  : http://localhost:$FrontendPort/login.html 에서 백엔드 주소 http://localhost:$BackendPort 로 로그인/회원가입"
    Write-Host "            (프론트·백엔드 모두 'localhost' 여야 로그인 유지 — 방금 검증에서 확정)"
}
Write-Host "  종료    : .\scripts\dev-stop.ps1"
Write-Host "=========================================="

if (-not $NoBrowser -and $frontUp) {
    $landing = if ($LocalOnly) { "index.html" } else { "login.html" }
    Start-Process "http://localhost:$FrontendPort/$landing"
}
