const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");

function loadEnvFile(envPath = path.join(ROOT_DIR, ".env")) {
  try {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.warn("[env] failed to load .env:", error.message);
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function getConfig() {
  return {
    rootDir: ROOT_DIR,
    stateDir: path.resolve(ROOT_DIR, process.env.STATE_DIR || "./data"),
    workdir: process.env.WORKDIR || process.env.HOME || "/root",
    feishu: {
      appId: required("FEISHU_APP_ID"),
      appSecret: required("FEISHU_APP_SECRET")
    },
    claude: {
      cmd: process.env.CLAUDE_CMD || "claude",
      model: process.env.CLAUDE_MODEL || null,
      permissionMode: process.env.CLAUDE_PERMISSION_MODE || null,
      useApprovalCards: parseBool(process.env.CLAUDE_APPROVAL_CARDS, true),
      autoApproveTools: parseList(process.env.CLAUDE_AUTO_APPROVE_TOOLS, [
        "Read", "Glob", "Grep", "TodoWrite", "TodoRead", "WebFetch", "WebSearch"
      ]),
      additionalArgs: parseArgs(process.env.CLAUDE_EXTRA_ARGS),
      turnTimeoutMs: toNonNegativeInt(process.env.CLAUDE_TURN_TIMEOUT_MS, 0),
      maxStreamChars: toPositiveInt(process.env.CLAUDE_MAX_STREAM_CHARS, 4000),
      streamFlushMs: toPositiveInt(process.env.CLAUDE_STREAM_FLUSH_MS, 350)
    },
    larkSdkPath: process.env.LARK_SDK_PATH || null
  };
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function parseList(value, fallback) {
  if (!value) return fallback;
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

function parseArgs(value) {
  if (!value) return [];
  return String(value).split(/\s+/).filter(Boolean);
}

function toPositiveInt(v, fallback) {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toNonNegativeInt(v, fallback) {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

module.exports = { ROOT_DIR, loadEnvFile, getConfig };
