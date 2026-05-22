#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

mkdir -p data
PID_FILE="$ROOT_DIR/data/gateway.pid"
LOG_FILE="$ROOT_DIR/data/gateway.log"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "feishu-claude-bot already running with PID $(cat "$PID_FILE")"
  exit 0
fi

nohup node "$ROOT_DIR/src/server.js" >>"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
echo "started feishu-claude-bot PID $(cat "$PID_FILE"), log: $LOG_FILE"
