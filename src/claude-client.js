const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

const MCP_SERVER_NAME = "feishu_approval";
const MCP_TOOL_NAME = "approve";
const PERMISSION_MCP_PATH = path.resolve(__dirname, "permission-mcp.js");

class ClaudeCodeClient {
  constructor(config, { approvalUrl = null } = {}) {
    this.config = config;
    this.approvalUrl = approvalUrl;
  }

  async runTurn(opts) {
    try {
      return await this.runTurnOnce(opts);
    } catch (error) {
      // Claude --resume fails with "No conversation found" if the persisted
      // session was rolled by a newer claude version, the project dir changed,
      // or claude purged its cache. Fall back to a fresh session transparently.
      const message = String(error?.message || "");
      if (opts.sessionId && /no conversation found|session.*not found/i.test(message)) {
        opts.onStatus?.("旧会话失效，新开会话");
        return await this.runTurnOnce({ ...opts, sessionId: null });
      }
      throw error;
    }
  }

  async runTurnOnce({
    sessionId,
    input,
    cwd,
    onStatus = () => {},
    onDelta = () => {},
    onTurnStarted = () => {}
  }) {
    const turnId = crypto.randomUUID();
    const args = this.buildArgs(sessionId, turnId);
    const workdir = cwd || this.config.workdir;

    onStatus("启动中");

    const child = spawn(this.config.claude.cmd, args, {
      cwd: workdir,
      env: {
        ...process.env,
        CLAUDE_CODE_NONINTERACTIVE: "1",
        FEISHU_BOT_TURN_ID: turnId,
        FEISHU_BOT_APPROVAL_URL: this.approvalUrl || ""
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let resolvedSessionId = sessionId || null;
    let answer = "";
    let stderrBuf = "";
    let killed = false;
    let resultError = null;
    const turn = { id: turnId, startedAt: Date.now() };
    onTurnStarted(turn, sessionId || null);

    const timeoutMs = this.config.claude.turnTimeoutMs;
    let timeoutHandle = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        killed = true;
        try { child.kill("SIGTERM"); } catch {}
      }, timeoutMs);
      timeoutHandle.unref?.();
    }

    const promptText = inputToText(input);
    const stdinPayload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: inputToContent(input, promptText)
      }
    }) + "\n";
    try {
      child.stdin.write(stdinPayload);
      child.stdin.end();
    } catch (error) {
      try { child.kill("SIGTERM"); } catch {}
      throw new Error(`无法写入 Claude stdin：${error.message}`);
    }

    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); }
      catch { return; }
      this.handleEvent(event, {
        onStatus,
        onDelta: (delta) => {
          answer += delta;
          onDelta(delta);
        }
      });
      if (event?.session_id && !resolvedSessionId) {
        resolvedSessionId = event.session_id;
      }
      if (event?.type === "result") {
        if (typeof event.result === "string") answer = event.result;
        if (event.is_error || event.subtype === "error_during_execution") {
          const errs = Array.isArray(event.errors) ? event.errors.join("; ") : "";
          resultError = errs || event.subtype || "claude reported is_error=true";
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrBuf += text;
      if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
      // Surface stderr live so the user can see *why* a turn failed.
      process.stderr.write(`[claude:${turnId.slice(0, 8)}] ${text}`);
    });

    return await new Promise((resolve, reject) => {
      child.on("error", (error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(new Error(`Claude 启动失败：${error.message}`));
      });
      child.on("close", (code, signal) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        stdoutReader.close();
        if (killed) {
          reject(new Error(`Claude 任务超时（${timeoutMs}ms）已终止`));
          return;
        }
        if (code !== 0) {
          const tail = stderrBuf.trim().slice(-1200) || `exit code ${code} signal ${signal}`;
          reject(new Error(`Claude 退出异常：${tail}`));
          return;
        }
        if (resultError) {
          // Claude exited 0 but emitted an error result event — surface that
          // so the caller can decide (e.g. fall back to a fresh session).
          reject(new Error(resultError));
          return;
        }
        if (!answer.trim()) answer = "(Claude 未返回文本回复)";
        resolve({
          turnId,
          sessionId: resolvedSessionId,
          finalText: answer,
          turn: { ...turn, status: "completed", durationMs: Date.now() - turn.startedAt }
        });
      });
    });
  }

  buildArgs(sessionId, turnId) {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--include-partial-messages",
      "--verbose"
    ];
    // Permission mode + approval cards are mutually exclusive control surfaces.
    // If approval cards are on, we delegate every permission decision to the
    // MCP tool and DO NOT set --permission-mode (leave at default).
    if (this.config.claude.useApprovalCards && this.approvalUrl) {
      args.push(
        "--permission-prompt-tool",
        `mcp__${MCP_SERVER_NAME}__${MCP_TOOL_NAME}`
      );
      const mcpConfig = {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: "stdio",
            command: process.execPath,
            args: [PERMISSION_MCP_PATH, turnId, this.approvalUrl]
          }
        }
      };
      args.push("--mcp-config", JSON.stringify(mcpConfig));
      // Auto-approve list goes through --allowedTools so noisy reads skip the card.
      if (this.config.claude.autoApproveTools.length) {
        args.push("--allowedTools", ...this.config.claude.autoApproveTools);
      }
    } else if (this.config.claude.permissionMode) {
      args.push("--permission-mode", this.config.claude.permissionMode);
    }

    if (this.config.claude.model) args.push("--model", this.config.claude.model);
    if (sessionId) args.push("--resume", sessionId);
    else args.push("--session-id", crypto.randomUUID());

    if (this.config.workdir) args.push("--add-dir", this.config.workdir);
    if (Array.isArray(this.config.claude.additionalArgs)) {
      args.push(...this.config.claude.additionalArgs);
    }
    return args;
  }

  handleEvent(event, ctx) {
    if (!event || typeof event !== "object") return;

    switch (event.type) {
      case "system":
        if (event.subtype === "init") ctx.onStatus("已连接");
        else if (event.subtype === "status") ctx.onStatus(mapStatus(event.status));
        return;

      case "stream_event": {
        const inner = event.event || {};
        switch (inner.type) {
          case "content_block_start": {
            const blockType = inner.content_block?.type;
            if (blockType === "thinking") ctx.onStatus("思考中");
            else if (blockType === "text") ctx.onStatus("生成中");
            else if (blockType === "tool_use") {
              const name = inner.content_block?.name || "tool";
              ctx.onStatus(`调用工具：${name}`);
            }
            return;
          }
          case "content_block_delta": {
            const d = inner.delta || {};
            if (d.type === "text_delta" && typeof d.text === "string") ctx.onDelta(d.text);
            return;
          }
          case "message_stop":
            ctx.onStatus("整理回复");
            return;
        }
        return;
      }

      case "assistant": {
        const blocks = event.message?.content || [];
        for (const block of blocks) {
          if (block?.type === "tool_use") ctx.onStatus(`调用工具：${block.name || "tool"}`);
        }
        return;
      }

      case "user":
        ctx.onStatus("继续处理");
        return;

      case "rate_limit_event":
        if (event.rate_limit_info?.status === "exceeded") ctx.onStatus("限流中");
        return;

      case "result":
        if (event.is_error) ctx.onStatus("失败");
        else ctx.onStatus("已完成");
        return;
    }
  }
}

function inputToText(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .map((item) => (item?.type === "text" ? String(item.text || "") : ""))
    .filter(Boolean)
    .join("\n");
}

function inputToContent(input, promptText) {
  if (Array.isArray(input) && input.some((i) => i?.type === "image" || i?.type === "localImage")) {
    const out = [];
    if (promptText) out.push({ type: "text", text: promptText });
    for (const item of input) {
      if (item?.type === "localImage" && item.path) {
        out.push({ type: "text", text: `(本地附件：${item.path})` });
      }
    }
    return out;
  }
  return [{ type: "text", text: promptText || "" }];
}

function mapStatus(status) {
  switch (status) {
    case "requesting": return "请求中";
    case "responding": return "生成中";
    case "thinking": return "思考中";
    case "executing": return "执行中";
    case "completed": return "已完成";
    default: return String(status || "进行中");
  }
}

module.exports = { ClaudeCodeClient };
