const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const STREAMING_CONTENT_ELEMENT_ID = "streaming_content";
const STATUS_FOOTER_ELEMENT_ID = "status_footer";

function loadLarkSdk(sdkPath) {
  try {
    return require("@larksuiteoapi/node-sdk");
  } catch (error) {
    if (!sdkPath) {
      throw new Error(
        "Missing @larksuiteoapi/node-sdk. Run `npm install`, or set LARK_SDK_PATH."
      );
    }
  }

  const absolutePath = path.resolve(sdkPath);
  return createRequire(absolutePath)(absolutePath);
}

class FeishuClient {
  constructor(config) {
    this.config = config;
    this.Lark = loadLarkSdk(config.larkSdkPath);
    this.sdk = new this.Lark.Client({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      appType: this.Lark.AppType.SelfBuild,
      domain: this.Lark.Domain.Feishu
    });
    this.wsClient = null;
    this.botOpenId = null;
    this.appAccessToken = null;
    this.appAccessTokenExpiresAt = 0;
  }

  async startLongConnection(onMessage, onCardAction = null) {
    await this.probeBot();

    const dispatcher = new this.Lark.EventDispatcher({
      decryptKey: "",
      verificationToken: ""
    });

    dispatcher.register({
      "im.message.receive_v1": async (data) => {
        // 飞书长连接事件必须尽快 ACK；业务处理放到后台，避免事件分发层等待 Codex/队列。
        Promise.resolve()
          .then(() => onMessage(data))
          .catch((error) => console.error("[feishu-event] async handler failed:", error));
      },
      "card.action.trigger": async (data) => {
        if (!onCardAction) return;
        Promise.resolve()
          .then(() => {
            const normalized =
              typeof this.Lark.normalizeCardAction === "function"
                ? this.Lark.normalizeCardAction(data)
                : normalizeCardAction(data);
            if (normalized) return onCardAction(normalized);
            return onCardAction(data);
          })
          .catch((error) => console.error("[feishu-card-action] async handler failed:", error));
      }
    });

    this.wsClient = new this.Lark.WSClient({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      domain: this.Lark.Domain.Feishu,
      loggerLevel: this.Lark.LoggerLevel.info
    });

    console.log("[feishu] websocket starting");
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async probeBot() {
    try {
      const data = await this.api("/bot/v3/info");
      const bot = data?.data?.bot || data?.bot || {};
      this.botOpenId = bot.open_id || bot.openId || null;
      console.log("[feishu] bot open_id:", this.botOpenId || "unknown");
    } catch (error) {
      console.warn("[feishu] bot probe failed:", error.message);
    }
  }

  async getAppAccessToken() {
    const now = Date.now();
    if (this.appAccessToken && now < this.appAccessTokenExpiresAt - 60_000) {
      return this.appAccessToken;
    }

    const response = await fetch(
      `${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: this.config.feishu.appId,
          app_secret: this.config.feishu.appSecret
        })
      }
    );

    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(
        `feishu token failed: ${response.status} ${JSON.stringify(data)}`
      );
    }

    this.appAccessToken = data.app_access_token;
    this.appAccessTokenExpiresAt = now + (data.expire - 120) * 1000;
    return this.appAccessToken;
  }

  async api(pathname, { method = "GET", query, body } = {}) {
    const url = new URL(`${FEISHU_BASE_URL}${pathname}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.getAppAccessToken()}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: body == null ? undefined : JSON.stringify(body)
    });

    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { rawText };
    }

    if (!response.ok || (data.code != null && data.code !== 0)) {
      throw new Error(
        `feishu api failed: ${method} ${pathname} ${response.status} ${JSON.stringify(data)}`
      );
    }
    return data;
  }

  async createStreamingReply(messageId) {
    const cardId = await this.createCardEntity(buildStreamingCard());
    const sent = await this.api(`/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      body: {
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: { card_id: cardId }
        })
      }
    });

    return {
      cardId,
      messageId: sent.data?.message_id || ""
    };
  }

  async replyInteractiveCard(messageId, card) {
    const cardId = await this.createCardEntity(card);
    const sent = await this.api(`/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      body: {
        msg_type: "interactive",
        content: JSON.stringify({
          type: "card",
          data: { card_id: cardId }
        })
      }
    });

    return {
      cardId,
      messageId: sent.data?.message_id || ""
    };
  }

  async createCardEntity(card) {
    const data = await this.api("/cardkit/v1/cards", {
      method: "POST",
      body: {
        type: "card_json",
        data: JSON.stringify(card)
      }
    });
    return data.data?.card_id || data.card_id;
  }

  async updateCardElementContent({
    cardId,
    elementId = STREAMING_CONTENT_ELEMENT_ID,
    content,
    sequence
  }) {
    return this.api(
      `/cardkit/v1/cards/${cardId}/elements/${encodeURIComponent(elementId)}/content`,
      {
        method: "PUT",
        body: { content, sequence }
      }
    );
  }

  async streamCardContent({ cardId, content, sequence }) {
    return this.updateCardElementContent({
      cardId,
      elementId: STREAMING_CONTENT_ELEMENT_ID,
      content,
      sequence
    });
  }

  async updateCard({ cardId, card, sequence }) {
    return this.api(`/cardkit/v1/cards/${cardId}`, {
      method: "PUT",
      body: {
        card: {
          type: "card_json",
          data: JSON.stringify(card)
        },
        sequence
      }
    });
  }

  async setCardStreamingMode({ cardId, sequence, streamingMode }) {
    try {
      return await this.api(`/cardkit/v1/cards/${cardId}/settings`, {
        method: "PUT",
        body: {
          settings: JSON.stringify({ streaming_mode: streamingMode }),
          sequence
        }
      });
    } catch (error) {
      // Some tenants appear to reject this endpoint with a plain 404 page
      // even though card streaming and card updates themselves succeed.
      if (String(error.message || "").includes('404')) {
        console.warn(
          `[feishu] ignore card settings 404 for card ${cardId}; leaving streaming_mode as-is`
        );
        return { ignored: true };
      }
      throw error;
    }
  }

  async uploadFile(filePath, fileName = path.basename(filePath)) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`not a file: ${filePath}`);
    }
    if (stat.size <= 0) {
      throw new Error(`empty file cannot be uploaded: ${filePath}`);
    }
    if (stat.size > 30 * 1024 * 1024) {
      throw new Error(`file too large for Feishu upload (>30MB): ${filePath}`);
    }

    const form = new FormData();
    form.set("file_type", "stream");
    form.set("file_name", fileName);
    const bytes = await fs.promises.readFile(filePath);
    form.set("file", new Blob([bytes]), fileName);

    const response = await fetch(`${FEISHU_BASE_URL}/im/v1/files`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.getAppAccessToken()}`
      },
      body: form
    });

    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { rawText };
    }

    if (!response.ok || (data.code != null && data.code !== 0)) {
      throw new Error(
        `feishu upload file failed: ${response.status} ${JSON.stringify(data)}`
      );
    }

    const fileKey = data.data?.file_key || data.file_key;
    if (!fileKey) {
      throw new Error(`feishu upload file returned no file_key: ${JSON.stringify(data)}`);
    }
    return fileKey;
  }

  async uploadImage(filePath) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`not a file: ${filePath}`);
    }
    if (stat.size <= 0) {
      throw new Error(`empty image cannot be uploaded: ${filePath}`);
    }
    if (stat.size > 10 * 1024 * 1024) {
      throw new Error(`image too large for Feishu image upload (>10MB): ${filePath}`);
    }

    const form = new FormData();
    form.set("image_type", "message");
    const fileName = path.basename(filePath);
    const bytes = await fs.promises.readFile(filePath);
    form.set("image", new Blob([bytes]), fileName);

    const response = await fetch(`${FEISHU_BASE_URL}/im/v1/images`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.getAppAccessToken()}`
      },
      body: form
    });

    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { rawText };
    }

    if (!response.ok || (data.code != null && data.code !== 0)) {
      throw new Error(
        `feishu upload image failed: ${response.status} ${JSON.stringify(data)}`
      );
    }

    const imageKey = data.data?.image_key || data.image_key;
    if (!imageKey) {
      throw new Error(`feishu upload image returned no image_key: ${JSON.stringify(data)}`);
    }
    return imageKey;
  }

  async uploadCardImage(filePath) {
    return this.uploadImage(filePath);
  }

  async replyImage(messageId, filePath) {
    const imageKey = await this.uploadImage(filePath);
    return this.api(`/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      body: {
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey })
      }
    });
  }

  async replyFile(messageId, filePath, fileName = path.basename(filePath)) {
    const fileKey = await this.uploadFile(filePath, fileName);
    return this.api(`/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      body: {
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey })
      }
    });
  }

  async replyText(messageId, text) {
    return this.api(`/im/v1/messages/${messageId}/reply`, {
      method: "POST",
      body: {
        msg_type: "text",
        content: JSON.stringify({ text })
      }
    });
  }

  async downloadMessageResource({
    messageId,
    fileKey,
    type,
    fileName,
    dir
  }) {
    const targetDir = dir || path.join(this.config.stateDir, "incoming-files");
    await fs.promises.mkdir(targetDir, { recursive: true });

    const safeName = uniqueResourceFileName(
      targetDir,
      sanitizeFileName(fileName || `${type || "resource"}-${fileKey}${defaultResourceExt(type)}`)
    );
    const targetPath = path.join(targetDir, safeName);

    const url = new URL(
      `${FEISHU_BASE_URL}/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`
    );
    url.searchParams.set("type", String(type || "file"));

    const response = await fetch(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${await this.getAppAccessToken()}`
      }
    });

    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || contentType.includes("application/json")) {
      const text = bytes.toString("utf8");
      let data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { rawText: text };
      }
      if (!response.ok || (data.code != null && data.code !== 0)) {
        throw new Error(
          `feishu download resource failed: ${response.status} ${JSON.stringify(data)}`
        );
      }
    }

    await fs.promises.writeFile(targetPath, bytes);
    return {
      path: targetPath,
      name: safeName,
      type,
      fileKey
    };
  }
}

function parseTextContent(rawContent) {
  if (!rawContent) return "";
  try {
    const content = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
    return typeof content?.text === "string" ? content.text : "";
  } catch {
    return "";
  }
}

function isFromBot(event, botOpenId) {
  if (!botOpenId) return false;
  return event?.sender?.sender_id?.open_id === botOpenId;
}

function normalizeCardAction(event) {
  const messageId = event?.context?.open_message_id || event?.open_message_id;
  const chatId = event?.context?.open_chat_id || event?.open_chat_id;
  const operatorOpenId = event?.operator?.open_id;
  if (!messageId || !chatId || !operatorOpenId) return null;
  return {
    messageId,
    chatId,
    operator: {
      openId: operatorOpenId,
      userId: event?.operator?.user_id,
      name: event?.operator?.name
    },
    action: {
      value: event?.action?.value,
      tag: event?.action?.tag || "unknown",
      name: event?.action?.name,
      option: event?.action?.option
    }
  };
}

function sanitizeFileName(name) {
  const cleaned = String(name || "file")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 180) || "file";
}

function uniqueResourceFileName(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext) || "file";
  let candidate = fileName;
  let index = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${index}${ext}`;
    index += 1;
  }
  return candidate;
}

function defaultResourceExt(type) {
  switch (type) {
    case "image":
      return ".jpg";
    case "media":
      return ".mp4";
    case "audio":
      return ".amr";
    default:
      return "";
  }
}

function buildStreamingCard() {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      locales: ["zh_cn", "en_us"],
      summary: {
        content: "Processing...",
        i18n_content: { zh_cn: "处理中...", en_us: "Processing..." }
      }
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "",
          text_align: "left",
          text_size: "normal_v2",
          margin: "0px 0px 0px 0px",
          element_id: STREAMING_CONTENT_ELEMENT_ID
        },
        buildStatusElement(formatStatusFooter({ status: "排队中", elapsedMs: 0 }))
      ]
    }
  };
}

function buildCompleteCard(input) {
  const options =
    input && typeof input === "object"
      ? input
      : {
          text: input
        };
  const {
    text = "",
    status = "已完成",
    elapsedMs = null,
    isError = false,
    images = []
  } = options;
  const plain = String(text || "").replace(/[*_`#>[\]()~]/g, "");
  const elements = [
    {
      tag: "markdown",
      content: text || "(empty)"
    },
    ...images.map((image) => ({
      tag: "img",
      img_key: image.imageKey,
      alt: {
        tag: "plain_text",
        content: image.name || "attachment"
      },
      mode: "fit_horizontal",
      preview: true
    })),
    buildStatusElement(formatStatusFooter({ status, elapsedMs, isError }))
  ];

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      locales: ["zh_cn", "en_us"],
      summary: { content: plain.slice(0, 120) || "Done" }
    },
    body: {
      elements
    }
  };
}

function buildStatusElement(content) {
  return {
    tag: "markdown",
    content,
    text_size: "notation",
    element_id: STATUS_FOOTER_ELEMENT_ID
  };
}

function formatStatusFooter({ status, elapsedMs, isError = false }) {
  const elapsed = formatShortElapsed(elapsedMs);
  const content = elapsed ? `状态：${status} · ${elapsed}` : `状态：${status}`;
  return isError ? `<font color='red'>${content}</font>` : content;
}

function formatShortElapsed(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}m ${rest.toFixed(1).padStart(4, "0")}s`;
}

module.exports = {
  FeishuClient,
  parseTextContent,
  isFromBot,
  buildCompleteCard,
  formatStatusFooter,
  STREAMING_CONTENT_ELEMENT_ID,
  STATUS_FOOTER_ELEMENT_ID
};
