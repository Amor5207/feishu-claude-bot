const fs = require("node:fs");
const path = require("node:path");
const { ROOT_DIR, loadEnvFile, getConfig } = require("./config");
const { JsonStore } = require("./fs-store");
const {
  FeishuClient,
  parseTextContent,
  isFromBot,
  buildCompleteCard,
  formatStatusFooter,
  STREAMING_CONTENT_ELEMENT_ID,
  STATUS_FOOTER_ELEMENT_ID
} = require("./feishu-client");
const { ClaudeCodeClient } = require("./claude-client");
const { ApprovalServer } = require("./approval-server");

loadEnvFile(path.join(ROOT_DIR, ".env"));
const config = getConfig();

fs.mkdirSync(config.stateDir, { recursive: true });

const sessions = new JsonStore(path.join(config.stateDir, "sessions.json"), {
  threads: {},
  seen: []
});
const queues = new Map();
const activeTurns = new Map();              // turnId -> { messageId, chatId, sourceOpenId, cardSession, ... }
const pendingCardRequests = new Map();      // requestId -> { sourceOpenId, cardId, onAction(payload) }
const sessionAutoApprovals = new Map();     // claudeSessionId -> Set<toolName>
const CARD_ACTION_APP = "feishu-claude-bot";

const feishu = new FeishuClient(config);
const approvalServer = new ApprovalServer({
  port: Number(process.env.APPROVAL_PORT || 19876),
  host: "127.0.0.1",
  handler: handleApprovalRequest
});
const claude = new ClaudeCodeClient(config, { approvalUrl: approvalServer.url() });

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});

async function main() {
  console.log("[boot] config: .env");
  console.log("[boot] claude cmd:", config.claude.cmd);
  console.log("[boot] approval cards:", config.claude.useApprovalCards);
  console.log("[boot] auto-approve:", config.claude.autoApproveTools.join(", ") || "(none)");
  console.log("[boot] workdir:", config.workdir);

  if (config.claude.useApprovalCards) await approvalServer.start();
  await feishu.startLongConnection(handleIncomingMessage, handleCardAction);
}

async function handleIncomingMessage(event) {
  try {
    const messageId = event?.message?.message_id;
    if (!messageId) return;
    if (hasSeen(messageId)) return;
    rememberSeen(messageId);

    if (isFromBot(event, feishu.botOpenId)) return;

    const incoming = parseIncomingMessage(event);
    if (!incoming.text && incoming.resources.length === 0) return;

    console.log(`[recv] msg=${messageId} chat=${event?.message?.chat_id} text=${truncate(incoming.text, 80)}`);

    const queueKey = getQueueKey(event);
    const cardReady = createAcceptedReply(messageId);
    const prev = queues.get(queueKey) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => processMessage(event, incoming, await cardReady))
      .catch((error) => console.error("[message] failed:", error));
    queues.set(queueKey, next);
  } catch (error) {
    console.error("[handler] failed:", error);
  }
}

async function createAcceptedReply(messageId) {
  try {
    const replyCard = await feishu.createStreamingReply(messageId);
    const cardSession = new ReplyCardSession({
      feishu,
      cardId: replyCard.cardId,
      sourceMessageId: messageId
    });
    cardSession.setStatus("排队中");
    cardSession.startHeartbeat();
    return cardSession;
  } catch (error) {
    console.error("[accepted-reply] failed:", error);
    return null;
  }
}

async function processMessage(event, incoming, acceptedCardSession = null) {
  const messageId = event.message.message_id;
  const threadKey = getQueueKey(event);
  const savedSessionId =
    sessions.get().threads[threadKey]?.claudeSessionId
    || findLatestSessionForChat(event?.message?.chat_id)?.claudeSessionId
    || null;
  const rawText = incoming.text.trim();

  let cardSession = acceptedCardSession;
  let answer = "";
  let activeTurnId = null;

  try {
    if (!cardSession) cardSession = await createAcceptedReply(messageId);
    cardSession?.setStatus(incoming.resources.length ? "解析附件" : "处理中");

    const downloaded = await downloadIncomingResources(messageId, incoming.resources, cardSession);
    const promptText = buildPromptText(rawText, downloaded);
    const input = buildClaudeInput(promptText, downloaded);

    const result = await claude.runTurn({
      sessionId: savedSessionId,
      input,
      onTurnStarted: (turn) => {
        activeTurnId = turn.id;
        activeTurns.set(turn.id, {
          messageId,
          chatId: event?.message?.chat_id,
          sourceOpenId: event?.sender?.sender_id?.open_id,
          cardSession,
          claudeSessionId: savedSessionId
        });
        cardSession?.setStatus("进行中");
      },
      onStatus: (status) => cardSession?.setStatus(status),
      onDelta: (delta) => {
        answer += delta;
        cardSession?.updateAnswer(truncate(answer, config.claude.maxStreamChars));
        cardSession?.setStatus("生成中");
      }
    });

    // Now that we know the real session id, re-key auto-approvals if they were
    // recorded against null (first turn case).
    if (result.sessionId && activeTurnId) {
      const ctx = activeTurns.get(activeTurnId);
      if (ctx) ctx.claudeSessionId = result.sessionId;
    }

    const finalText = result.finalText || answer || "(empty)";
    const { displayText, attachments } = extractAttachmentRequests(finalText, config.workdir);
    const { inlineImages, remainingAttachments } = await prepareInlineImages(attachments);
    const cardText =
      displayText
      || (inlineImages.length || remainingAttachments.length ? "已生成附件。" : finalText);
    if (cardSession) {
      await cardSession.finalize({
        text: cardText,
        status: "已完成",
        elapsedMs: result.turn?.durationMs,
        images: inlineImages
      });
    } else {
      await safeReplyText(messageId, cardText);
    }

    await sendRequestedAttachments(messageId, remainingAttachments);

    if (result.sessionId) {
      sessions.update((draft) => {
        draft.threads[threadKey] = {
          claudeSessionId: result.sessionId,
          updatedAt: new Date().toISOString()
        };
      });
    }
  } catch (error) {
    console.error("[message] failed:", error);
    const errorText = formatErrorForUser(error);
    const fallback = answer.trim()
      ? `${answer.trim()}\n\n---\n请求失败：${errorText}`
      : `请求失败：${errorText}`;
    if (cardSession) {
      await cardSession
        .finalize({ text: fallback, status: "出错", isError: true })
        .catch(async (nested) => {
          console.error("[card-finalize] failed:", nested);
          await safeReplyText(messageId, fallback);
        });
    } else {
      await safeReplyText(messageId, fallback);
    }
  } finally {
    if (activeTurnId) activeTurns.delete(activeTurnId);
  }
}

// ---------------------------------------------------------------------------
// Approval flow (called by approval-server when permission-mcp posts /approve)
// ---------------------------------------------------------------------------

async function handleApprovalRequest({ turnId, toolName, input, toolUseId }) {
  const ctx = activeTurns.get(turnId);
  if (!ctx) {
    return { behavior: "deny", message: `unknown turn ${turnId}` };
  }
  // Auto-approve list bypass (also enforced via --allowedTools but kept here
  // as a safety net in case Claude routes everything through MCP anyway).
  if (config.claude.autoApproveTools.includes(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  // Session-level "always allow" recorded by previous card click.
  const sessionId = ctx.claudeSessionId;
  if (sessionId && sessionAutoApprovals.get(sessionId)?.has(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }

  ctx.cardSession?.setStatus(`等待授权：${toolName}`);

  const decision = await sendApprovalCard(ctx, { toolName, input, toolUseId });

  if (decision.scope === "session" && sessionId) {
    const set = sessionAutoApprovals.get(sessionId) || new Set();
    set.add(toolName);
    sessionAutoApprovals.set(sessionId, set);
  }

  ctx.cardSession?.setStatus(decision.behavior === "allow" ? "继续处理" : "已拒绝");

  return {
    behavior: decision.behavior,
    updatedInput: decision.behavior === "allow" ? input : undefined,
    message: decision.message
  };
}

async function sendApprovalCard(ctx, { toolName, input, toolUseId }) {
  const requestId = `${ctx.messageId}:${toolUseId || cryptoRandom()}`;
  const content = formatApprovalCardBody(toolName, input);

  return new Promise(async (resolve) => {
    try {
      const sent = await feishu.replyInteractiveCard(
        ctx.messageId,
        buildChoiceCard({
          requestId,
          title: `授权工具：${toolName}`,
          content,
          buttons: [
            { label: "本次允许", type: "primary", payload: { behavior: "allow", scope: "turn", label: "本次允许" } },
            { label: "本会话总是允许", type: "default", payload: { behavior: "allow", scope: "session", label: "本会话总是允许" } },
            { label: "拒绝", type: "danger", payload: { behavior: "deny", scope: "turn", label: "拒绝" } }
          ]
        })
      );
      pendingCardRequests.set(requestId, {
        sourceOpenId: ctx.sourceOpenId,
        cardId: sent.cardId,
        onAction: async (payload) => {
          pendingCardRequests.delete(requestId);
          await feishu.updateCard({
            cardId: sent.cardId,
            card: buildResolvedChoiceCard({
              title: `授权工具：${toolName}`,
              content,
              selection: payload.label || payload.behavior
            }),
            sequence: Date.now()
          });
          resolve({
            behavior: payload.behavior || "deny",
            scope: payload.scope || "turn",
            message: payload.label || ""
          });
        }
      });
    } catch (error) {
      console.error("[approval-card] failed:", error);
      resolve({ behavior: "deny", scope: "turn", message: `卡片发送失败：${error.message}` });
    }
  });
}

function formatApprovalCardBody(toolName, input) {
  const lines = [`**工具**：\`${toolName}\``];
  if (input && typeof input === "object") {
    const summary = summariseInput(toolName, input);
    if (summary) lines.push("", summary);
    const remaining = JSON.stringify(input, null, 2);
    if (remaining.length <= 2000) {
      lines.push("", "```json", remaining, "```");
    } else {
      lines.push("", `（参数过长，已截断，共 ${remaining.length} 字符）`);
    }
  }
  return lines.join("\n");
}

function summariseInput(toolName, input) {
  switch (toolName) {
    case "Bash":
      return input.command ? "```bash\n" + String(input.command).slice(0, 1200) + "\n```" : "";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return input.file_path ? `文件：\`${input.file_path}\`` : "";
    case "Read":
      return input.file_path ? `读取：\`${input.file_path}\`` : "";
    default:
      return "";
  }
}

async function handleCardAction(event) {
  const value = normalizeActionValue(event?.action?.value);
  if (!value || value.app !== CARD_ACTION_APP || !value.requestId) return;

  const pending = pendingCardRequests.get(String(value.requestId));
  if (!pending) {
    await safeReplyText(event.messageId, "这个授权请求已经处理过了。");
    return;
  }
  if (pending.sourceOpenId && event?.operator?.openId
      && pending.sourceOpenId !== event.operator.openId) {
    await safeReplyText(event.messageId, "只有发起这次任务的人可以授权。");
    return;
  }
  try {
    await pending.onAction(value.payload || {}, event);
  } catch (error) {
    console.error("[card-action] failed:", error);
    await safeReplyText(event.messageId, `授权处理失败：${formatErrorForUser(error)}`);
  }
}

function normalizeActionValue(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (typeof value === "object") return value;
  return null;
}

function buildChoiceCard({ requestId, title, content, buttons }) {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    body: {
      elements: [
        { tag: "markdown", content: content || title },
        {
          tag: "action",
          layout: "flow",
          actions: buttons.map((button) => ({
            tag: "button",
            text: { tag: "plain_text", content: button.label },
            type: button.type || "default",
            value: { app: CARD_ACTION_APP, requestId, payload: button.payload }
          }))
        }
      ]
    }
  };
}

function buildResolvedChoiceCard({ title, content, selection }) {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `${title}：${selection || ""}`.slice(0, 120) } },
    body: {
      elements: [{
        tag: "markdown",
        content: [
          content || title,
          selection ? `\n\n**已选择：${String(selection).replace(/[*_`#[\]()~>]/g, "")}**` : "\n\n**已处理**"
        ].join("")
      }]
    }
  };
}

function cryptoRandom() {
  return require("node:crypto").randomUUID();
}

// ---------------------------------------------------------------------------
// Message / resource parsing (copied from feishu-codex-bot)
// ---------------------------------------------------------------------------

function parseIncomingMessage(event) {
  const message = event?.message || {};
  const messageType = message.message_type;
  const content = parseContentObject(message.content);
  const resources = [];
  let text = "";

  switch (messageType) {
    case "text":
      text = parseTextContent(message.content).trim();
      break;
    case "post":
      text = extractPostTextAndResources(content, resources).trim();
      break;
    case "file":
      addResource(resources, { type: "file", fileKey: content.file_key, fileName: content.file_name });
      break;
    case "image":
      addResource(resources, { type: "image", fileKey: content.image_key, fileName: content.file_name });
      break;
    case "audio":
      addResource(resources, { type: "audio", fileKey: content.file_key, fileName: content.file_name });
      break;
    case "media":
      addResource(resources, { type: "media", fileKey: content.file_key, fileName: content.file_name });
      if (content.image_key) {
        addResource(resources, {
          type: "image", fileKey: content.image_key,
          fileName: `${content.file_name || "media"}-cover.jpg`
        });
      }
      break;
    default:
      if (typeof content.text === "string") text = content.text.trim();
      if (content.file_key) addResource(resources, { type: messageType || "file", fileKey: content.file_key, fileName: content.file_name });
      if (content.image_key) addResource(resources, { type: "image", fileKey: content.image_key, fileName: content.file_name });
      break;
  }
  return { text, resources };
}

function parseContentObject(rawContent) {
  if (!rawContent) return {};
  if (typeof rawContent === "object") return rawContent;
  try { return JSON.parse(rawContent); } catch { return {}; }
}

function extractPostTextAndResources(content, resources) {
  const body = content?.content ? content : content?.zh_cn || content?.en_us || content?.ja_jp || content || {};
  const lines = [];
  if (body.title) lines.push(body.title);
  for (const paragraph of body.content || []) {
    if (!Array.isArray(paragraph)) continue;
    const parts = [];
    for (const item of paragraph) {
      switch (item?.tag) {
        case "text": parts.push(item.text || ""); break;
        case "a": parts.push(item.text || item.href || ""); break;
        case "at": parts.push(item.user_name ? `@${item.user_name}` : ""); break;
        case "img":
          if (item.image_key) {
            addResource(resources, { type: "image", fileKey: item.image_key, fileName: item.file_name });
            parts.push("[图片]");
          }
          break;
        case "media":
          if (item.file_key) {
            addResource(resources, { type: "media", fileKey: item.file_key, fileName: item.file_name });
            parts.push("[视频/文件]");
          }
          break;
        default: if (item?.text) parts.push(item.text); break;
      }
    }
    if (parts.join("").trim()) lines.push(parts.join(""));
  }
  return lines.join("\n");
}

function addResource(resources, resource) {
  if (!resource.fileKey) return;
  const key = `${resource.type}:${resource.fileKey}`;
  if (resources.some((item) => `${item.type}:${item.fileKey}` === key)) return;
  resources.push({
    type: normalizeResourceType(resource.type),
    fileKey: resource.fileKey,
    fileName: resource.fileName
  });
}

function normalizeResourceType(type) {
  if (type === "image" || type === "audio" || type === "media") return type;
  return "file";
}

async function downloadIncomingResources(messageId, resources, cardSession) {
  if (!resources.length) return [];
  const downloaded = [];
  const dir = path.join(config.stateDir, "incoming-files", sanitizePathPart(messageId));
  for (const resource of resources) {
    cardSession?.setStatus(`下载附件 ${downloaded.length + 1}/${resources.length}`);
    const fileName = resource.fileName || defaultIncomingFileName(resource);
    const file = await feishu.downloadMessageResource({
      messageId, fileKey: resource.fileKey, type: resource.type, fileName, dir
    });
    downloaded.push({ ...file, messageType: resource.type });
  }
  return downloaded;
}

function buildPromptText(text, attachments) {
  const lines = [];
  if (text) lines.push(text);
  if (attachments.length) {
    if (!text) lines.push("请解析我发送的文件。");
    lines.push("");
    lines.push("用户随这条飞书消息发送了以下文件，已下载到本机。请按用户意图直接读取、解析或引用这些文件：");
    for (const file of attachments) {
      lines.push(`- ${file.name} (${file.messageType || file.type}): ${file.path}`);
    }
  }
  return lines.join("\n").trim();
}

function buildClaudeInput(text, attachments) {
  const input = [{ type: "text", text }];
  for (const attachment of attachments) {
    if (isImagePath(attachment.path)) input.push({ type: "localImage", path: attachment.path });
  }
  return input;
}

function defaultIncomingFileName(resource) {
  switch (resource.type) {
    case "image": return `${resource.fileKey}.jpg`;
    case "media": return `${resource.fileKey}.mp4`;
    case "audio": return `${resource.fileKey}.amr`;
    default: return resource.fileKey;
  }
}

function sanitizePathPart(value) {
  return String(value || "message").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

async function prepareInlineImages(attachments) {
  const inlineImages = [];
  const remainingAttachments = [];
  for (const attachment of attachments) {
    if (!isImagePath(attachment.path)) { remainingAttachments.push(attachment); continue; }
    try {
      const imageKey = await feishu.uploadCardImage(attachment.path);
      inlineImages.push({ imageKey, name: attachment.name });
    } catch (error) {
      console.warn("[card-image] inline upload failed:", error.message);
      remainingAttachments.push(attachment);
    }
  }
  return { inlineImages, remainingAttachments };
}

async function sendRequestedAttachments(messageId, attachments) {
  if (!attachments.length) return;
  for (const attachment of attachments) {
    try {
      if (isImagePath(attachment.path)) await feishu.replyImage(messageId, attachment.path);
      else await feishu.replyFile(messageId, attachment.path, attachment.name);
    } catch (error) {
      console.error("[reply-file] failed:", attachment.path, error);
      await safeReplyText(messageId, `附件发送失败：${attachment.path}\n${formatErrorForUser(error)}`);
    }
  }
}

function extractAttachmentRequests(text, workdir) {
  const attachments = [];
  const kept = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const parsed = parseAttachmentLine(line, workdir);
    if (!parsed) { kept.push(line); continue; }
    if (!seen.has(parsed.path)) {
      seen.add(parsed.path);
      attachments.push(parsed);
    }
  }
  return { displayText: kept.join("\n").trim(), attachments };
}

function parseAttachmentLine(line, workdir) {
  const trimmed = String(line || "").trim();
  const patterns = [
    /^\[?(?:飞书)?附件\s*[:：]\s*(.+?)\]?$/i,
    /^\[?attachment\s*[:=]\s*(.+?)\]?$/i,
    /^<attachment\s+path=["'](.+?)["']\s*\/?\s*>$/i
  ];
  let value = null;
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) { value = match[1]; break; }
  }
  if (!value) return null;
  value = value.trim().replace(/^file:\/\//, "").replace(/^['"]|['"]$/g, "");
  const resolved = path.resolve(workdir || config.workdir, value);
  try {
    if (!fs.statSync(resolved).isFile()) return null;
  } catch { return null; }
  return { path: resolved, name: path.basename(resolved) };
}

function isImagePath(filePath) {
  return /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i.test(filePath);
}

async function safeReplyText(messageId, text) {
  try { await feishu.replyText(messageId, text); }
  catch (error) { console.error("[reply-text] failed:", error); }
}

function formatErrorForUser(error) {
  const message = String(error?.message || error || "未知错误");
  return message.length > 1200 ? `${message.slice(0, 1200)}...` : message;
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function getQueueKey(event) {
  const chatId = event?.message?.chat_id || "unknown";
  const rootId = event?.message?.root_id || event?.message?.parent_id || "chat";
  return `${chatId}:${rootId}`;
}

function findLatestSessionForChat(chatId) {
  if (!chatId) return null;
  let latest = null;
  for (const [key, value] of Object.entries(sessions.get().threads || {})) {
    if (!key.startsWith(`${chatId}:`) || !value?.claudeSessionId) continue;
    if (!latest || String(value.updatedAt || "") > String(latest.updatedAt || "")) latest = value;
  }
  return latest;
}

function hasSeen(messageId) {
  return sessions.get().seen.includes(messageId);
}

function rememberSeen(messageId) {
  sessions.update((draft) => {
    draft.seen.push(messageId);
    draft.seen = draft.seen.slice(-5000);
  });
}

class ReplyCardSession {
  constructor({ feishu, cardId, sourceMessageId }) {
    this.feishu = feishu;
    this.cardId = cardId;
    this.sourceMessageId = sourceMessageId;
    this.startedAt = Date.now();
    this.sequence = 1;
    this.status = "排队中";
    this.closed = false;
    this.queue = Promise.resolve();
    this.statusPromise = Promise.resolve();
    this.statusInFlight = false;
    this.pendingStatusContent = null;
    this.heartbeat = null;
    this.lastRenderedStatusContent = "";
  }
  elapsedMs() { return Date.now() - this.startedAt; }
  startHeartbeat() {
    this.updateStatus();
    this.heartbeat = setInterval(() => this.updateStatus(), 200);
    this.heartbeat.unref?.();
  }
  setStatus(status) {
    if (!status || this.closed || this.status === status) return;
    this.status = status;
    this.updateStatus();
  }
  updateAnswer(content) {
    if (this.closed) return;
    this.enqueue("content", () =>
      this.feishu.updateCardElementContent({
        cardId: this.cardId, elementId: STREAMING_CONTENT_ELEMENT_ID,
        content, sequence: this.nextSequence()
      })
    ).catch((error) => console.error("[card-stream] failed:", error.message));
  }
  updateStatus() {
    if (this.closed) return;
    const content = formatStatusFooter({ status: this.status, elapsedMs: this.elapsedMs() });
    if (content === this.lastRenderedStatusContent || content === this.pendingStatusContent) return;
    this.pendingStatusContent = content;
    this.drainStatusUpdates();
  }
  drainStatusUpdates() {
    if (this.closed || this.statusInFlight || !this.pendingStatusContent) return;
    const content = this.pendingStatusContent;
    this.pendingStatusContent = null;
    this.statusInFlight = true;
    this.statusPromise = this.enqueue("status", () =>
      this.feishu.updateCardElementContent({
        cardId: this.cardId, elementId: STATUS_FOOTER_ELEMENT_ID,
        content, sequence: this.nextSequence()
      })
    )
      .then(() => { this.lastRenderedStatusContent = content; })
      .catch((error) => console.warn("[card-status] failed:", error.message))
      .finally(() => { this.statusInFlight = false; this.drainStatusUpdates(); });
  }
  async finalize({ text, status, elapsedMs, isError = false, images = [] }) {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.flush();
    await this.enqueue("final", async () => {
      await this.feishu.updateCard({
        cardId: this.cardId,
        card: buildCompleteCard({
          text, status, elapsedMs: elapsedMs ?? this.elapsedMs(),
          isError, images
        }),
        sequence: this.nextSequence()
      });
      try {
        await this.feishu.setCardStreamingMode({
          cardId: this.cardId, sequence: this.nextSequence(), streamingMode: false
        });
      } catch (error) {
        console.warn("[card-finalize] setCardStreamingMode failed:", error.message);
      }
    });
  }
  async flush() {
    try { await this.queue; } catch {}
    try { await this.statusPromise; } catch {}
  }
  enqueue(label, operation) {
    const run = this.queue.catch(() => {}).then(operation);
    this.queue = run;
    return run.catch((error) => {
      console.warn(`[card-${label}] update failed:`, error.message);
      throw error;
    });
  }
  nextSequence() { return this.sequence++; }
}
