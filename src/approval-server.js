// Bot-local HTTP server that brokers tool-permission requests between
// permission-mcp.js (spawned by claude) and Feishu cards.
//
// Two endpoints:
//   POST /approve           — called by permission-mcp.js with the permission
//                             request. Returns the decision JSON.
//   GET  /healthz           — liveness probe.
//
// The bot supplies a handler that takes the request and returns the decision;
// the server is just transport.

const http = require("node:http");

class ApprovalServer {
  constructor({ port = 19876, host = "127.0.0.1", handler }) {
    this.port = port;
    this.host = host;
    this.handler = handler;
    this.server = null;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        console.log(`[approval-server] listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  url() {
    return `http://${this.host}:${this.port}`;
  }

  async handleRequest(req, res) {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/approve") {
      res.writeHead(404).end("not found");
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      res.writeHead(400).end(`bad json: ${error.message}`);
      return;
    }

    try {
      const decision = await this.handler(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(decision));
    } catch (error) {
      console.error("[approval-server] handler failed:", error);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        behavior: "deny",
        message: `bot internal error: ${error.message || String(error)}`
      }));
    }
  }
}

module.exports = { ApprovalServer };
