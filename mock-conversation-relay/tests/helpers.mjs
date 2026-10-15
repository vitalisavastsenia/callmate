import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { loadConfig } from "../dist/server/config.js";
import { createApp } from "../dist/server/app.js";
import { Controller } from "../dist/server/controller.js";
import twilio from "twilio";

export async function until(predicate) {
  for (let index = 0; index < 250; index++) { if (predicate()) return; await delay(10); }
  assert.fail("Timed out waiting for local fixture traffic");
}
export async function backend(t, options = {}) {
  const messages = []; const callbacks = []; const twimlRequests = []; const sockets = new Map(); const closes = [];
  let origin; let xml; let actionXml = "<Response><Hangup/></Response>";
  const authToken = options.authToken ?? "mock-auth-token-local-only";
  const handshakes = [];
  const server = createServer((req, res) => { void (async () => {
    let body = ""; for await (const chunk of req) body += chunk.toString();
    const url = new URL(req.url, origin);
    const fields = Object.fromEntries(req.method === "GET" ? url.searchParams : new URLSearchParams(body));
    const signatureValid = twilio.validateRequest(authToken, req.headers["x-twilio-signature"] ?? "", origin + req.url, req.method === "GET" ? {} : fields);
    const capture = { path: url.pathname, method: req.method, headers: req.headers, fields, signatureValid };
    if (!signatureValid) { res.writeHead(403).end(); return; }
    if (url.pathname === "/status" || url.pathname === "/action" || url.pathname === "/broken-status") {
      callbacks.push(capture);
      const response = url.pathname === "/action" ? options.onAction ? await options.onAction() : actionXml : "<Response><Hangup/></Response>";
      res.writeHead(url.pathname === "/broken-status" ? 503 : 200, { "content-type": "text/xml" }).end(response);
    } else if (url.pathname === "/twiml") { twimlRequests.push(capture); res.writeHead(200, { "content-type": "text/xml" }).end(xml); }
    else if (url.pathname === "/redirect") res.writeHead(302, { location: "http://example.com/" }).end();
    else res.writeHead(404).end();
  })().catch(() => res.writeHead(500).end()); });
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;
  server.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers["x-callmate-mock"], "true");
    const signedUrl = origin.replace("http:", "ws:") + req.url;
    const signatureValid = twilio.validateRequest(authToken, req.headers["x-twilio-signature"] ?? "", signedUrl, {});
    handshakes.push({ url: signedUrl, signatureValid });
    if (!signatureValid) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    if (new URL(req.url, origin).pathname !== "/voice") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      let callSid;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()); messages.push({ callSid: callSid ?? message.callSid, message });
        if (message.type === "setup") { callSid = message.callSid; sockets.set(callSid, ws); }
      });
      ws.on("close", (code, reason) => closes.push({ callSid, code, reason: reason.toString() }));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const wsUrl = origin.replace("http:", "ws:") + "/voice";
  xml = `<Response><Connect action="${origin}/action"><ConversationRelay url="${wsUrl}" language="pl-PL" welcomeGreeting="Dzień dobry."><Parameter name="taskId" value="task-demo-001"/><Parameter name="customerName" value="Alex &amp; Ola"/></ConversationRelay></Connect></Response>`;
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { origin, wsUrl, messages, callbacks, twimlRequests, sockets, closes, handshakes,
    set actionXml(value) { actionXml = value; },
    set xml(value) { xml = value; }, get xml() { return xml; }, get connections() { return connections; },
    send(id, value) { sockets.get(id).send(typeof value === "string" ? value : JSON.stringify(value)); },
    async setup(id) { await until(() => sockets.has(id)); return messages.find((entry) => entry.callSid === id && entry.message.type === "setup").message; },
  };
}
export async function service(t, upstream, extraEnv = {}, options = {}) {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", CALLMATE_WS_URL: upstream.wsUrl,
    CALLMATE_TWIML_URL: upstream.origin + "/twiml", ...extraEnv });
  const controller = new Controller(config, options);
  const { app } = createApp(config, controller);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const auth = "Basic " + Buffer.from(`${config.MOCK_API_USERNAME}:${config.MOCK_API_PASSWORD}`).toString("base64");
  const root = `/2010-04-01/Accounts/${config.MOCK_ACCOUNT_SID}/Calls`;
  const request = async (path, method = "GET", body, headers = {}) => {
    const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  return { app, origin, root, auth, config, controller, request,
    async create(input = {}) { const response = await request("/api/sessions", "POST", input); assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body; },
    async form(path, fields, authHeader = auth) {
      const response = await fetch(origin + path, { method: "POST", headers: { authorization: authHeader, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
      return { status: response.status, body: await response.json() };
    },
  };
}
