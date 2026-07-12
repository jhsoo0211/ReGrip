#!/usr/bin/env bash
# ReGrip dev 통합 종료 (macOS/Linux/Git-Bash)
#
# dev-start.sh 가 기록한 PID 파일을 우선 사용하고, 없으면 포트 8000/3000 리스너를
# 폴백으로 찾아 종료한다.
#
# 사용: ./scripts/dev-stop.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.dev-pids"
BACKEND_PORT=8000
FRONTEND_PORT=3000
KILLED=()

port_pids() { lsof -ti tcp:"$1" -s tcp:LISTEN 2>/dev/null || true; }

# ---- 1) PID 파일 기반 ----
if [ -f "$PID_FILE" ]; then
  while IFS='=' read -r key val; do
    case "$key" in
      backendPort)  BACKEND_PORT="$val" ;;
      frontendPort) FRONTEND_PORT="$val" ;;
      backend|frontend)
        if [ -n "$val" ] && kill -0 "$val" 2>/dev/null; then
          kill "$val" 2>/dev/null || true; KILLED+=("$key (PID $val)")
        fi ;;
    esac
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# ---- 2) 포트 폴백 ----
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  for pid in $(port_pids "$port"); do
    kill "$pid" 2>/dev/null && KILLED+=("포트 $port (PID $pid)") || true
  done
done

sleep 1
# ---- 3) 잔존 강제 종료 + 확인 ----
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  for pid in $(port_pids "$port"); do kill -9 "$pid" 2>/dev/null || true; done
done

if [ "${#KILLED[@]}" -gt 0 ]; then
  echo "[dev-stop] 종료됨: ${KILLED[*]}"
else
  echo "[dev-stop] 실행 중인 dev 프로세스가 없습니다."
fi
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if [ -n "$(port_pids "$port")" ]; then echo "[주의] 포트 $port 아직 점유 중."; else echo "[dev-stop] 포트 $port 해제 확인."; fi
done
