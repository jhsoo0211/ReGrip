#!/usr/bin/env bash
# ReGrip dev 통합 시작 (macOS/Linux/Git-Bash)
#
# 백엔드(FastAPI :8000)와 프론트(정적 서버 :3000)를 백그라운드로 띄우고,
# 백엔드 /health 가 준비될 때까지 기다린다. 로그: scripts/backend.log, scripts/frontend.log
#
# 사용:
#   ./scripts/dev-start.sh            # 기본
#   ./scripts/dev-start.sh --force    # 포트 점유 프로세스를 종료하고 진행
#   ./scripts/dev-start.sh --local    # 백엔드 없이 프론트만(로컬 저장 모드)
#
# 중요: 프론트는 http://localhost:3000 으로 접속한다(백엔드 CORS 화이트리스트 +
#       refresh 쿠키 SameSite=Strict 때문에 프론트·백엔드 호스트명이 같아야 함).
# 종료: ./scripts/dev-stop.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SCRIPT_DIR/.dev-pids"
BACKEND_PORT=8000
FRONTEND_PORT=3000
FORCE=0
LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --local) LOCAL_ONLY=1 ;;
  esac
done

port_pids() { lsof -ti tcp:"$1" -s tcp:LISTEN 2>/dev/null || true; }

PORTS=("$FRONTEND_PORT")
[ "$LOCAL_ONLY" -eq 0 ] && PORTS=("$BACKEND_PORT" "$FRONTEND_PORT")
for port in "${PORTS[@]}"; do
  pids="$(port_pids "$port")"
  if [ -n "$pids" ]; then
    if [ "$FORCE" -eq 1 ]; then
      echo "[dev-start] 포트 $port 점유 프로세스 종료: $pids"; kill -9 $pids 2>/dev/null || true
    else
      echo "[dev-start] 포트 $port 사용 중 ($pids). ./scripts/dev-stop.sh 또는 --force 사용."; exit 1
    fi
  fi
done

: > "$PID_FILE"
BACKEND_PID=""
if [ "$LOCAL_ONLY" -eq 0 ]; then
  PYBIN="$REPO_ROOT/backend/venv/bin/python"
  [ -x "$PYBIN" ] || PYBIN="$REPO_ROOT/backend/venv/Scripts/python.exe"   # Git-Bash on Windows
  if [ ! -x "$PYBIN" ]; then
    echo "[오류] backend/venv 가 없습니다. cd backend && python3.11 -m venv venv && venv/bin/pip install -r requirements.txt"; exit 1
  fi
  echo "[dev-start] 백엔드 기동 중... (uvicorn src.main:app --port $BACKEND_PORT)"
  ( cd "$REPO_ROOT/backend" && "$PYBIN" -m uvicorn src.main:app --port "$BACKEND_PORT" ) > "$SCRIPT_DIR/backend.log" 2>&1 &
  BACKEND_PID=$!
  echo "backend=$BACKEND_PID" >> "$PID_FILE"

  echo "[dev-start] /health 대기..."
  for _ in $(seq 1 80); do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      echo "[오류] 백엔드가 기동 중 종료됨 — scripts/backend.log 확인 (개발 DB 스키마 드리프트면 backend/regrip_dev.db 삭제)"; exit 1
    fi
    if curl -sf "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1; then break; fi
    sleep 0.7
  done
  curl -sf "http://127.0.0.1:$BACKEND_PORT/health" >/dev/null 2>&1 || { echo "[오류] /health 준비 실패"; exit 1; }
  echo "[dev-start] 백엔드 준비 완료."
fi

echo "[dev-start] 프론트 기동 중... (정적 서버 :$FRONTEND_PORT)"
FRONT_PY="$(command -v python3 || command -v python)"
( cd "$REPO_ROOT" && "$FRONT_PY" -m http.server "$FRONTEND_PORT" --bind 127.0.0.1 ) > "$SCRIPT_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "frontend=$FRONTEND_PID" >> "$PID_FILE"
echo "backendPort=$BACKEND_PORT" >> "$PID_FILE"
echo "frontendPort=$FRONTEND_PORT" >> "$PID_FILE"

echo ""
echo "=========================================="
echo " ReGrip dev 환경 기동 완료"
[ "$LOCAL_ONLY" -eq 0 ] && echo "  백엔드  : http://127.0.0.1:$BACKEND_PORT  (docs: /docs, PID $BACKEND_PID)"
echo "  프론트  : http://localhost:$FRONTEND_PORT  (PID $FRONTEND_PID)"
if [ "$LOCAL_ONLY" -eq 0 ]; then
  echo "  로그인  : http://localhost:$FRONTEND_PORT/login.html (백엔드 주소 http://localhost:$BACKEND_PORT)"
else
  echo "  모드    : 로컬 저장(서버 미연결)"
fi
echo "  로그    : scripts/backend.log, scripts/frontend.log"
echo "  종료    : ./scripts/dev-stop.sh"
echo "=========================================="
