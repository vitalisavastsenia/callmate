import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import Database from "better-sqlite3";
import { ApiErrorSchema, ReadinessSchema, SettingsSchema } from "@callmate/contracts";
import { loadConfig } from "../dist/config.js";
import { migrate, openStore } from "../dist/storage.js";
import { createRuntime } from "../dist/server.js";

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "callmate-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function setup(t, mode = "simulator", stream) {
  const config = loadConfig({ CALLMATE_DATA_DIR: directory(t), CALLMATE_MODE: mode, CALLMATE_LOG_LEVEL: stream ? "info" : "silent" });
  const runtime = createRuntime(config, stream);
  t.after(() => runtime.close());
  return { config, ...runtime };
}
const local = { host: "localhost:3000" };

test("configuration rejects invalid ports, paths and modes without echoing values", () => {
  assert.equal(loadConfig({}).mode, "simulator");
  for (const env of [
    { CALLMATE_API_PORT: "0" }, { CALLMATE_API_PORT: "65536" },
    { CALLMATE_CALLBACK_PORT: "3000" }, { CALLMATE_DATA_DIR: "relative" },
    { CALLMATE_DATA_DIR: "/" }, { CALLMATE_MODE: "unexpected-private-value" },
  ]) assert.throws(() => loadConfig(env));
  assert.throws(() => loadConfig({ CALLMATE_MODE: "unexpected-private-value" }), (error) => {
    assert.match(error.message, /mode/);
    assert.ok(!error.message.includes("unexpected-private-value"));
    return true;
  });
});

test("SQLite migration is repeatable, settings persist, and files are private", (t) => {
  const dataDir = directory(t);
  let store = openStore(dataDir);
  const initial = store.getSettings();
  const changed = { ...initial, transcriptRetentionDays: 14 };
  assert.deepEqual(store.setSettings(changed), changed);
  store.close();
  store = openStore(dataDir);
  try {
    assert.deepEqual(store.getSettings(), changed);
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dataDir, "callmate.sqlite")).mode & 0o777, 0o600);
    assert.throws(() => store.setSettings({ ...changed, secret: "synthetic-value" }));
    assert.deepEqual(store.getSettings(), changed);
  } finally { store.close(); }
});

test("failed migrations roll back SQL and migration records together", (t) => {
  const migrationsDir = directory(t);
  writeFileSync(join(migrationsDir, "001_first.sql"), "CREATE TABLE first_table (id INTEGER);");
  writeFileSync(join(migrationsDir, "002_broken.sql"), "CREATE TABLE partial_table (id INTEGER); INSERT INTO missing_table VALUES (1);");
  const db = new Database(":memory:");
  try {
    assert.throws(() => migrate(db, migrationsDir));
    assert.equal(db.prepare("SELECT count(*) AS count FROM schema_migrations").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('first_table', 'partial_table')").get().count, 0);
  } finally { db.close(); }
});

test("edited or unknown applied migrations block startup", (t) => {
  const migrationsDir = directory(t);
  const path = join(migrationsDir, "001_first.sql");
  writeFileSync(path, "CREATE TABLE example (id INTEGER);");
  const db = new Database(":memory:");
  try {
    migrate(db, migrationsDir);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n-- changed`);
    assert.throws(() => migrate(db, migrationsDir), /migration history/);
    db.prepare("UPDATE schema_migrations SET version = 999").run();
    assert.throws(() => migrate(db, migrationsDir), /migration history/);
  } finally { db.close(); }
});

test("private settings API validates shared schemas and preserves stored values on bad input", async (t) => {
  const { privateApi } = setup(t);
  const get = await privateApi.inject({ url: "/api/v1/settings", headers: local });
  assert.equal(get.statusCode, 200);
  const settings = SettingsSchema.parse(get.json());
  const changed = { ...settings, transcriptRetentionDays: 7 };
  const saved = await privateApi.inject({ method: "PUT", url: "/api/v1/settings", headers: local, payload: changed });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json(), changed);
  const bad = await privateApi.inject({ method: "PUT", url: "/api/v1/settings", headers: local,
    payload: { ...changed, transcriptRetentionDays: 0, apiKey: "synthetic-secret" } });
  assert.equal(bad.statusCode, 400);
  ApiErrorSchema.parse(bad.json());
  assert.ok(!bad.body.includes("synthetic-secret"));
  assert.deepEqual((await privateApi.inject({ url: "/api/v1/settings", headers: local })).json(), changed);
});

test("private API rejects foreign Host/Origin, cross-site requests, and simple form commands", async (t) => {
  const { privateApi } = setup(t);
  for (const headers of [
    { host: "foreign.example:3000" }, { ...local, origin: "https://foreign.example" },
    { ...local, "sec-fetch-site": "cross-site" }, { ...local, origin: "null" },
  ]) {
    const response = await privateApi.inject({ url: "/api/v1/settings", headers });
    assert.equal(response.statusCode, 400);
    ApiErrorSchema.parse(response.json());
  }
  const form = await privateApi.inject({ method: "PUT", url: "/api/v1/settings",
    headers: { ...local, "content-type": "text/plain" }, payload: "private-form-value" });
  assert.equal(form.statusCode, 400);
  assert.ok(!form.body.includes("private-form-value"));
  const sameOrigin = await privateApi.inject({ url: "/api/v1/settings", headers: { ...local, origin: "http://localhost:3000" } });
  assert.equal(sameOrigin.statusCode, 200);
});

test("callback listener exposes no private, health, or unauthenticated provider routes", async (t) => {
  const { callbacks } = setup(t);
  for (const path of ["/health", "/api/v1/readiness", "/api/v1/settings", "/twilio/voice", "/twilio/status", "/twilio/relay-ended", "/twilio/relay"]) {
    for (const method of ["GET", "POST"]) {
      const response = await callbacks.inject({ method, url: path });
      assert.equal(response.statusCode, 404, `${method} ${path}`);
      ApiErrorSchema.parse(response.json());
    }
  }
});

test("signed mock progress route is unavailable in production, live mode and fake-provider mode", async (t) => {
  for (const override of [{ NODE_ENV: 'production' }, { CALLMATE_MODE: 'live' }, { TELEPHONY_PROVIDER: 'fake' }]) {
    const config = loadConfig({ CALLMATE_DATA_DIR: directory(t), CALLMATE_LOG_LEVEL: 'silent',
      NODE_ENV: 'test', TELEPHONY_PROVIDER: 'mock', ...override });
    const runtime = createRuntime(config); t.after(() => runtime.close());
    const response = await runtime.callbacks.inject({ method: 'POST', url: '/callbacks/mock/status/00000000-0000-4000-8000-000000000000',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-callmate-mock': 'true' }, payload: 'CallStatus=completed' });
    assert.equal(response.statusCode, 404);
  }
});

test("only simulator mode is ready; live providers remain unavailable", async (t) => {
  for (const mode of ["simulator", "live"]) {
    const { privateApi } = setup(t, mode);
    assert.equal((await privateApi.inject({ url: "/health", headers: local })).statusCode, 200);
    const response = await privateApi.inject({ url: "/api/v1/readiness", headers: local });
    const readiness = ReadinessSchema.parse(response.json());
    assert.equal(readiness.mode, mode);
    assert.equal(readiness.ready, mode === "simulator");
    assert.equal(readiness.checks.find((check) => check.name === "storage").status, "ready");
    assert.equal(readiness.voiceEngine, null);
    const start = await privateApi.inject({ method: "POST", url: "/api/v1/calls", headers: local, payload: {} });
    assert.equal(start.statusCode, 400);
  }
});

test("logs and unexpected-error responses omit bodies, URLs, credentials, and exception values", async (t) => {
  let logs = "";
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk.toString(); done(); } });
  const { privateApi, close } = setup(t, "simulator", stream);
  privateApi.get("/test-error", async () => { throw new Error("private-exception-value"); });
  const response = await privateApi.inject({ url: "/test-error?token=private-query-value",
    headers: { ...local, authorization: "Bearer private-header-value", "x-request-id": "private-request-id" } });
  assert.equal(response.statusCode, 500);
  ApiErrorSchema.parse(response.json());
  await privateApi.inject({ method: "PUT", url: "/api/v1/settings", headers: local, payload: { token: "private-body-value" } });
  await close();
  assert.match(logs, /Request completed/);
  for (const value of ["private-exception-value", "private-query-value", "private-header-value", "private-body-value", "private-request-id"]) {
    assert.ok(!logs.includes(value), `Log leaked ${value}`);
    assert.ok(!response.body.includes(value), `Response leaked ${value}`);
  }
});

test("a second-listener startup failure closes the already-started private listener", async (t) => {
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: directory(t), CALLMATE_LOG_LEVEL: "silent" }),
    apiPort: 0, callbackPort: occupied.address().port };
  const runtime = createRuntime(config);
  t.after(() => runtime.close());
  await assert.rejects(runtime.start(), { code: "EADDRINUSE" });
  assert.equal(runtime.privateApi.server.listening, false);
  assert.equal(runtime.callbacks.server.listening, false);
});

test("real HTTP listeners start separately and close cleanly", async (t) => {
  const config = { ...loadConfig({ CALLMATE_DATA_DIR: directory(t), CALLMATE_LOG_LEVEL: "silent" }), apiPort: 0, callbackPort: 0 };
  const runtime = createRuntime(config);
  t.after(() => runtime.close());
  await runtime.start();
  const apiPort = runtime.privateApi.server.address().port;
  const callbackPort = runtime.callbacks.server.address().port;
  assert.notEqual(apiPort, callbackPort);
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${callbackPort}/api/v1/settings`)).status, 404);
  await runtime.close();
  assert.equal(runtime.privateApi.server.listening, false);
  assert.equal(runtime.callbacks.server.listening, false);
});
