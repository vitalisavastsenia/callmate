import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Window } from "happy-dom";
import { initializeConsole } from "../src/web/app.js";

const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
const id = "10000000-0000-4000-8000-000000000001";
const conversation = (extra = {}) => ({ id, initialMessage: "Hola, una cita por favor.", language: "es-ES", status: "ringing", callSid: "CA" + "0".repeat(32),
  responses: [], error: null, operatorUrl: "http://localhost:8080/?callId=CA" + "0".repeat(32), ...extra });
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); }
  assert.fail("Console did not update");
}
async function browser(t, fetch) {
  const win = new Window({ url: "http://localhost:3000/", settings: { disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  win.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs, ""));
  Object.defineProperty(win, "fetch", { value: async (path, options) => fetch(path, options), configurable: true });
  const ui = initializeConsole(win, win.document);
  t.after(() => { ui.cleanup(); win.happyDOM.abort(); });
  await ui.ready;
  return { win, ui, el: (id) => win.document.getElementById(id), submit() { win.document.getElementById("conversation-form").dispatchEvent(new win.Event("submit", { cancelable: true })); } };
}
const ok = (value) => ({ ok: true, json: async () => value });

test("simple console sends the editor text and language, prevents duplicate Start and offers the operator link", async (t) => {
  const requests = [];
  const ui = await browser(t, async (path, options) => {
    requests.push({ path, options });
    if (options?.method === "POST") {
      const input = JSON.parse(options.body);
      return ok({ conversation: conversation({ initialMessage: input.initialMessage, language: input.language }) });
    }
    return ok({ conversation: null });
  });
  assert.equal(ui.el("start").disabled, false); ui.submit();
  assert.equal(requests.length, 1); // Blank drafts never start a call.
  const text = 'Здравствуйте!\nМожно записаться завтра? <img src=x> 🧪 ';
  ui.el("initial-message").value = text; ui.el("language").value = "ru-RU";
  ui.submit(); ui.submit();
  await until(() => ui.el("status").textContent.includes("Waiting for the operator"));
  const starts = requests.filter(({ options }) => options?.method === "POST"); assert.equal(starts.length, 1);
  const body = JSON.parse(starts[0].options.body);
  assert.equal(body.initialMessage, text); assert.equal(body.language, "ru-RU"); assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
  assert.equal(ui.el("start").disabled, true); assert.equal(ui.el("stop").disabled, false);
  assert.equal(ui.el("operator-link").hidden, false); assert.match(ui.el("operator-link").href, /localhost:8080/);
  assert.equal(ui.el("initial-message").value, text); assert.equal(ui.win.document.querySelector("img"), null);
});

test("refresh restores the same conversation and safely displays human replies; Stop preserves the response", async (t) => {
  const response = '<script>alert(1)</script> Sí, mañana a las seis. 🧪 ';
  let state = conversation({ status: "connected", responses: [{ text: response, language: "es-ES", at: "2026-10-15T10:00:00Z" }] });
  const requests = [];
  const ui = await browser(t, async (path, options) => {
    requests.push({ path, options });
    if (options?.method === "POST") state = { ...state, status: "completed" };
    return ok({ conversation: state });
  });
  assert.equal(ui.el("initial-message").value, state.initialMessage); assert.equal(ui.el("response").value, response);
  assert.equal(ui.el("response").readOnly, true); assert.match(ui.el("response-meta").textContent, /1 reply/);
  assert.equal(ui.win.document.querySelectorAll("script").length, 0);
  ui.el("stop").click(); await until(() => ui.el("status").textContent === "Conversation ended");
  assert.equal(ui.el("start").disabled, false); assert.equal(ui.el("response").value, response);
  assert.equal(requests.filter(({ options }) => options?.method === "POST").length, 1);
  assert.equal(requests.at(-1).path, `/api/dev/conversations/${id}/stop`);
});

test("a stale poll cannot overwrite a newly started conversation; failed polling shows an error and prevents blind retries", async (t) => {
  let getCount = 0; let resolveOld; let offline = false;
  const ui = await browser(t, async (_path, options) => {
    if (offline) throw new Error("Backend unavailable");
    if (options?.method === "POST") return ok({ conversation: conversation() });
    if (++getCount === 2) return new Promise((resolve) => { resolveOld = resolve; });
    return ok({ conversation: null });
  });
  const oldPoll = ui.ui.refresh();
  ui.el("initial-message").value = "Hello"; ui.submit();
  await until(() => ui.el("status").textContent.includes("Waiting for the operator"));
  resolveOld(ok({ conversation: null })); await oldPoll;
  assert.equal(ui.el("start").disabled, true); assert.equal(ui.el("stop").disabled, false);
  offline = true; await ui.ui.refresh();
  assert.equal(ui.el("notice").hidden, false); assert.match(ui.el("notice").textContent, /Backend unavailable/);
  assert.equal(ui.el("start").disabled, true); assert.equal(ui.el("initial-message").value, "Hello");
});

test('Stop remains available while Start is waiting and its terminal response wins over a delayed Start', async (t) => {
  let resolveStart; let startId; const requests = [];
  const ui = await browser(t, async (path, options) => {
    requests.push({ path, options });
    if (!options?.method) return ok({ conversation: null });
    if (path.endsWith('/stop')) return ok({ conversation: conversation({ id: startId, status: 'completed' }) });
    startId = JSON.parse(options.body).requestId;
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  ui.el('initial-message').value = 'Hello'; ui.submit();
  assert.equal(ui.el('stop').disabled, false); ui.el('stop').click();
  await until(() => requests.some((request) => request.path.endsWith('/stop')));
  resolveStart(ok({ conversation: conversation({ id: startId, status: 'ringing' }) }));
  await until(() => ui.el('status').textContent === 'Conversation ended');
  assert.equal(ui.el('start').disabled, false); assert.equal(ui.el('stop').disabled, true);
  assert.equal(requests.filter((request) => request.path.endsWith('/stop')).length, 1);
});

test('Stop retries after an in-transit Start that initially returned not found', async (t) => {
  let resolveStart; let startId; let stops = 0;
  const ui = await browser(t, async (path, options) => {
    if (!options?.method) return ok({ conversation: null });
    if (path.endsWith('/stop')) {
      if (++stops === 1) return { ok: false, status: 404, json: async () => ({ error: { message: 'Not found' } }) };
      return ok({ conversation: conversation({ id: startId, status: 'completed' }) });
    }
    startId = JSON.parse(options.body).requestId;
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  ui.el('initial-message').value = 'Hello'; ui.submit(); ui.el('stop').click();
  await until(() => stops === 1); await delay(10);
  assert.match(ui.el('status').textContent, /Stopping/);
  resolveStart(ok({ conversation: conversation({ id: startId }) }));
  await until(() => ui.el('status').textContent === 'Conversation ended');
  assert.equal(stops, 2); assert.equal(ui.el('start').disabled, false);
});
