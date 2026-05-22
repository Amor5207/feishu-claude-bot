#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
SERVICE_NAME="feishu-claude-bot"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令: $1" >&2
    return 1
  fi
}

prompt_if_empty() {
  local var_name="$1"
  local prompt="$2"
  local secret="${3:-false}"
  local value="${!var_name:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
    return
  fi
  if [[ "$secret" == "true" ]]; then
    read -rsp "$prompt: " value
    echo >&2
  else
    read -rp "$prompt: " value
  fi
  printf '%s' "$value"
}

escape_env_value() {
  local value="$1"
  value="${value//$'\r'/}"
  value="${value//$'\n'/}"
  printf '%s' "$value"
}

upsert_env() {
  local key="$1"
  local value="$2"
  touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE"; then
    python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1:]
lines = open(path, encoding='utf-8').read().splitlines()
with open(path, 'w', encoding='utf-8') as f:
    replaced = False
    for line in lines:
        if line.startswith(key + '='):
            f.write(f'{key}={value}\n')
            replaced = True
        else:
            f.write(line + '\n')
    if not replaced:
        f.write(f'{key}={value}\n')
PY
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

main() {
  cd "$ROOT_DIR"
  echo "== Feishu Claude Bot 通用安装 =="

  need_cmd node
  need_cmd npm
  need_cmd claude
  need_cmd python3

  local node_major
  node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
  if (( node_major < 22 )); then
    echo "Node.js 版本需 >=22，当前: $(node -v)" >&2
    exit 1
  fi

  if ! claude --version >/dev/null 2>&1; then
    echo "警告：claude --version 失败。请确认已登录：claude" >&2
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    cp .env.example "$ENV_FILE"
  fi

  local app_id app_secret workdir model claude_cmd
  app_id="$(prompt_if_empty FEISHU_APP_ID "请输入飞书 App ID（cli_xxx）")"
  app_secret="$(prompt_if_empty FEISHU_APP_SECRET "请输入飞书 App Secret" true)"
  workdir="${WORKDIR:-$(grep -E '^WORKDIR=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
  workdir="${workdir:-$HOME}"
  model="${CLAUDE_MODEL:-$(grep -E '^CLAUDE_MODEL=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
  claude_cmd="${CLAUDE_CMD:-$(command -v claude || echo claude)}"

  upsert_env FEISHU_APP_ID "$(escape_env_value "$app_id")"
  upsert_env FEISHU_APP_SECRET "$(escape_env_value "$app_secret")"
  upsert_env WORKDIR "$(escape_env_value "$workdir")"
  upsert_env CLAUDE_CMD "$(escape_env_value "$claude_cmd")"
  upsert_env CLAUDE_MODEL "$(escape_env_value "$model")"
  upsert_env STATE_DIR "./data"

  mkdir -p data

  echo "== 安装 Node 依赖 =="
  npm install

  echo "== 飞书后台需确认 =="
  echo "1. 自建应用 -> 开启机器人能力"
  echo "2. 事件订阅 -> 长连接"
  echo "3. 订阅事件：im.message.receive_v1"
  echo "4. 卡片回调：card.action.trigger"
  echo "5. 发布/重新发布应用"

  if command -v systemctl >/dev/null 2>&1 && [[ "${INSTALL_SYSTEMD:-1}" == "1" && "$(id -u)" == "0" ]]; then
    echo "== 安装 systemd 服务 =="
    cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<SERVICE
[Unit]
Description=Feishu Claude Bot Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${ROOT_DIR}
Environment=PATH=${PATH}
ExecStart=$(command -v node) ${ROOT_DIR}/src/server.js
Restart=always
RestartSec=3
KillMode=mixed

[Install]
WantedBy=multi-user.target
SERVICE
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME" >/dev/null
    systemctl restart "$SERVICE_NAME"
    echo "已启动：systemctl status ${SERVICE_NAME} --no-pager"
    echo "看日志：journalctl -u ${SERVICE_NAME} -f"
  else
    echo "== 后台启动 =="
    bash "$ROOT_DIR/stop.sh" || true
    bash "$ROOT_DIR/start.sh"
  fi

  echo "安装完成。"
}

main "$@"
