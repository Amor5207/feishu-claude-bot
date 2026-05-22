#!/usr/bin/env node
// Minimal stdio MCP server that proxies tool-permission requests from
// Claude Code to the feishu-claude-bot process over a local HTTP endpoint.
//
// Invocation by the bot, embedded in --mcp-config:
//   node permission-mcp.js <turnId> <botUrl>
// Example botUrl: http://127.0.0.1:19876

const http = require("node:http");
const readline = require("node:readline");

const [, , turnId, botUrl] = process.argv;
if (!turnId || !botUrl) {
  process.stderr.write("permission-mcp: missing turnId/botUrl\n");
  process.exit(2);
}
process.stderr.write(`permission-mcp: started turn=${turnId} bot=${botUrl}\n`);

const TOOL_NAME = "approve";
const TOOL_DESCRIPTION =
  "Ask the human (via Feishu card) whether Claude may use a given tool. " +
  "Returns {behavior:'allow'|'deny', updatedInput?, message?}.";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (error) { return; }
  handleMessage(msg).catch((error) => {
    if (msg?.id != null) {
      writeMessage({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: error.message || String(error) }
      });
    }
  });
});

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleMessage(msg) {
  switch (msg.method) {
    case "initialize":
      writeMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "feishu-claude-approval", version: "0.1.0" }
        }
      });
      return;

    case "notifications/initialized":
      return; // no response

    case "tools/list":
      writeMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [{
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" },
                tool_use_id: { type: "string" }
              },
              required: ["tool_name", "input"]
            }
          }]
        }
      });
      return;

    case "tools/call": {
      const args = msg.params?.arguments || {};
      process.stderr.write(`permission-mcp: tools/call ${args.tool_name} -> bot\n`);
      const decision = await requestDecision(args);
      process.stderr.write(`permission-mcp: decision ${JSON.stringify(decision)}\n`);
      writeMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          // Claude permission-prompt-tool expects the JSON payload as a text
          // block whose text parses to {behavior, updatedInput?, message?}.
          content: [{ type: "text", text: JSON.stringify(decision) }]
        }
      });
      return;
    }

    case "ping":
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;

    case "prompts/list":
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: { prompts: [] } });
      return;

    case "resources/list":
      writeMessage({ jsonrpc: "2.0", id: msg.id, result: { resources: [] } });
      return;

    default:
      if (msg.id != null) {
        writeMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `unsupported method: ${msg.method}` }
        });
      }
      return;
  }
}

function requestDecision(payload) {
  const body = JSON.stringify({
    turnId,
    toolName: payload.tool_name,
    input: payload.input,
    toolUseId: payload.tool_use_id || null
  });

  return new Promise((resolve, reject) => {
    const url = new URL("/approve", botUrl);
    const req = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => { buf += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            // Fail closed: deny with a clear message instead of crashing claude.
            return resolve({
              behavior: "deny",
              message: `bot approval endpoint returned ${res.statusCode}: ${buf.slice(0, 200)}`
            });
          }
          try {
            resolve(JSON.parse(buf));
          } catch (error) {
            resolve({ behavior: "deny", message: `bot returned invalid json: ${error.message}` });
          }
        });
      }
    );
    req.on("error", (error) => {
      // Connection refused / timeout: deny with reason.
      resolve({ behavior: "deny", message: `bot unreachable: ${error.message}` });
    });
    req.write(body);
    req.end();
  });
}
