#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/data/gateway.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "no PID file at $PID_FILE — nothing to stop"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in $(seq 1 20); do
    sleep 0.2
    kill -0 "$PID" 2>/dev/null || break
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" || true
  fi
  echo "stopped PID $PID"
else
  echo "PID $PID not running (stale pid file)"
fi
rm -f "$PID_FILE"
