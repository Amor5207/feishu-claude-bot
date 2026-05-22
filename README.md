# Feishu Claude Bot

通用版飞书长连接机器人：填入飞书 `App ID` / `App Secret` 后，飞书消息会交给本机 Claude Code 执行并把结果回到飞书。

> 本仓库及代码由 AI 自动创建。代码的准确性、完整性、安全性和特定用途适用性不作保证；使用前请自行审查和验证，使用风险自负。

## 特性

- 一条 `install.sh` 完成依赖安装、飞书凭据写入和服务启动。
- 使用飞书长连接接收消息，不需要自行暴露公网 webhook。
- 本机 `claude --print --output-format stream-json` 处理会话，飞书仅作为聊天入口。
- CardKit 流式输出回复和状态。
- 支持文本回复中的 `附件: /绝对路径/文件名` 自动上传；图片优先内联显示。
- 工具授权卡片：Claude 想用 `Bash`、`Write` 等敏感工具时，发飞书卡片让你点「本次允许 / 本会话总是允许 / 拒绝」。
- 支持用户发送文件、图片、富文本图片，机器人会下载到本机再交给 Claude 解析。
- 每个聊天/话题保存一个 Claude `session_id`，下条消息自动用 `--resume` 接上。

## 一键安装

```bash
git clone https://github.com/Amor5207/feishu-claude-bot.git
cd feishu-claude-bot
bash install.sh
```

安装脚本会做这些事：

1. 检查 `node >= 22`、`npm`、`claude`。
2. 交互输入或读取环境变量：
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
3. 生成/更新 `.env`。
4. 执行 `npm install` 安装飞书 SDK。
5. root + systemd 环境下自动安装并启动 `feishu-claude-bot.service`；否则用 `start.sh` 后台启动。

也支持非交互安装：

```bash
FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=xxx \
WORKDIR=/root \
bash install.sh
```

## 前置条件

- Node.js ≥ 22
- 已安装并登录 `claude`（[Claude Code](https://claude.com/claude-code)）。
- 飞书自建应用，开启机器人能力 + 长连接事件订阅。

### 飞书后台配置

1. 自建应用 → 启用机器人能力。
2. 事件订阅 → 订阅方式：**长连接**。
3. 添加事件：`im.message.receive_v1`。
4. 添加卡片回调：`card.action.trigger`（授权卡片要用）。
5. 发布/重新发布应用。

## 配置（`.env`）

| 变量 | 作用 | 默认 |
|------|------|------|
| `FEISHU_APP_ID` | 飞书自建应用 App ID | 必填 |
| `FEISHU_APP_SECRET` | 对应 App Secret | 必填 |
| `WORKDIR` | Claude 的工作目录（也是 `--add-dir`） | `/root` |
| `STATE_DIR` | sessions/附件落盘目录 | `./data` |
| `CLAUDE_CMD` | claude CLI 路径 | `claude` |
| `CLAUDE_MODEL` | 模型覆盖（如 `claude-sonnet-4-6`） | 默认（opus 4.7） |
| `CLAUDE_PERMISSION_MODE` | 权限模式 `default/acceptEdits/auto/plan/dontAsk`；启用授权卡片时留空 | 空 |
| `CLAUDE_APPROVAL_CARDS` | 启用飞书授权卡片 (`true`/`false`) | `true` |
| `CLAUDE_AUTO_APPROVE_TOOLS` | 跳过卡片直接放行的工具，逗号分隔 | `Read,Glob,Grep,TodoWrite,TodoRead,WebFetch,WebSearch` |
| `CLAUDE_EXTRA_ARGS` | 追加到每次 claude 调用的参数 | 空 |
| `CLAUDE_TURN_TIMEOUT_MS` | 单轮硬超时；`0` 不限 | `0` |
| `APPROVAL_PORT` | 授权 HTTP 本地端口 | `19876` |
| `LARK_SDK_PATH` | `@larksuiteoapi/node-sdk` 不在 node_modules 时的路径 | 自动 |

## 授权卡片

启用 `CLAUDE_APPROVAL_CARDS=true` 时（默认开）：

- Claude 想使用任何**不在** `CLAUDE_AUTO_APPROVE_TOOLS` 中的工具，先发卡片到飞书：
  - **本次允许**：仅这一次放行，参数原样传给工具
  - **本会话总是允许**：这个 Claude 会话期间该工具自动放行
  - **拒绝**：返回 deny，Claude 会按拒绝继续推理
- 卡片只有原始消息发起人能点。
- 卡片内容会带上工具参数（`Bash` 展示命令，`Edit`/`Write` 展示文件路径，其它工具展示 JSON）。

底层用 stdio MCP server（`src/permission-mcp.js`）+ 本地 HTTP 桥（`src/approval-server.js`），跟 Claude `--permission-prompt-tool` 集成。

## 服务管理

systemd：

```bash
systemctl status feishu-claude-bot
journalctl -u feishu-claude-bot -f
```

非 systemd：

```bash
bash start.sh   # 后台启动
bash stop.sh    # 停止
tail -f data/gateway.log
```

## 文件结构

- `src/server.js` — 主进程：飞书长连接、消息队列、卡片流、附件管道
- `src/claude-client.js` — claude CLI 子进程封装，事件解析，stream-json
- `src/permission-mcp.js` — stdio MCP server，由 claude 进程加载，转发授权请求到 bot
- `src/approval-server.js` — bot 端本地 HTTP，桥接 MCP 请求和飞书卡片
- `src/feishu-client.js` — Feishu OpenAPI 客户端：长连接、卡片、上传下载
- `src/fs-store.js` — `sessions.json` 持久化
- `src/config.js` — 读 `.env`

## 故障排查

- **卡片不出但消息无响应**：检查 `journalctl -u feishu-claude-bot -f` 是否有 `[recv]` 行；没有的话飞书没把消息送过来，重新发布应用 / 检查事件订阅。
- **Claude 提示 "Something went wrong / use /new"**：查看上面 `[claude:xxxx]` 开头的 stderr，通常是模型不可用或会话错乱。删掉 `data/sessions.json` 对应键值后重试。
- **授权卡片 deny "bot unreachable"**：`APPROVAL_PORT` 占用，换一个端口或杀掉占用进程。
- **root 用户 `--dangerously-skip-permissions cannot be used with root/sudo`**：本 bot 不使用该 flag。如果你在 `CLAUDE_EXTRA_ARGS` 里手动加了，去掉。

## License

MIT
