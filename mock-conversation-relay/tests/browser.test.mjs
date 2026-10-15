import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Window } from "happy-dom";
import { initializeOperator } from "../dist/web/operator.js";
import { SpeechController } from "../dist/web/speech.js";
import { Controller } from "../dist/server/controller.js";
import { loadConfig } from "../dist/server/config.js";

const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
function browser(t, withSpeech = false) {
  const win = new Window({ url: "http://localhost:8080/", settings: { disableJavaScriptEvaluation: true,
    disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  win.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs, ""));
  const sockets = []; const sent = [];
  class FakeSocket extends win.EventTarget {
    static OPEN = 1; readyState = 0;
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send(raw) { sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.dispatchEvent(new win.Event("close")); }
    open() { this.readyState = 1; this.dispatchEvent(new win.Event("open")); }
    message(value) { this.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(value) })); }
  }
  Object.defineProperty(win, "WebSocket", { value: FakeSocket, configurable: true });
  Object.defineProperty(win, "fetch", { value: async () => { throw new Error("No network allowed in browser unit tests"); }, configurable: true });
  const spoken = []; let canceled = 0; const recognitions = [];
  if (withSpeech) {
    const synthesis = new win.EventTarget();
    synthesis.getVoices = () => [{ voiceURI: "polski", name: "Polski", lang: "pl-PL" }];
    synthesis.speak = (value) => spoken.push(value); synthesis.cancel = () => { canceled++; };
    Object.defineProperty(win, "speechSynthesis", { value: synthesis, configurable: true });
    Object.defineProperty(win, "SpeechSynthesisUtterance", { value: class { constructor(text) { this.text = text; } }, configurable: true });
    Object.defineProperty(win, "SpeechRecognition", { value: class {
      constructor() { recognitions.push(this); }
      start() { this.started = true; }
      stop() { this.stopped = true; this.onend?.(); }
      abort() { this.stopped = true; this.onend?.(); }
    }, configurable: true });
  }
  const ui = initializeOperator(win, win.document);
  t.after(() => { ui.cleanup(); win.happyDOM.abort(); });
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const controller = new Controller(config); const view = controller.create({ customParameters: { taskId: "dom-test" } });
  view.status = "in-progress"; view.connection = "connected"; view.operatorId = "browser-1";
  const socket = sockets[0]; socket.open(); socket.message({ type: "snapshot", operatorId: "browser-1",
    config: { language: "pl-PL", from: "from", to: "to", relayWsUrl: "ws://127.0.0.1:3001/voice", twimlUrl: "http://127.0.0.1:3001/twiml", browserSpeech: true, maxActiveCalls: 5 }, sessions: [view] });
  const el = (id) => win.document.getElementById(id);
  return { win, ui, el, view, socket, sockets, sent, spoken, recognitions, get canceled() { return canceled; } };
}
function entry(text, id = "reply", extra = {}) {
  return { id, at: new Date().toISOString(), speaker: "assistant", text, final: true,
    lang: "pl-PL", interruptible: true, preemptible: false, ...extra };
}

for (const [lang, label, prompt, reply] of [
  ["ru-RU", "Русский", "Здравствуйте, можно записаться на стрижку?", "Да, завтра в 18:00. Ждём вас!"],
  ["es-ES", "Español", "¿Puedo reservar una cita mañana?", "Sí, mañana a las 18:00. ¡Gracias!"],
]) {
  test(`${lang} is selectable and reaches typed prompts, recognition, transcripts and synthesis`, (t) => {
    const ui = browser(t, true);
    for (const id of ["create-language", "language"]) {
      const option = [...ui.el(id).options].find((item) => item.value === lang);
      assert.ok(option); assert.match(option.textContent, new RegExp(label));
    }
    ui.el("language").value = lang;
    ui.el("language").dispatchEvent(new ui.win.Event("change"));
    assert.equal(ui.sent.at(-1).type, "language"); assert.equal(ui.sent.at(-1).language, lang);
    ui.socket.message({ type: "session", session: { ...ui.view, language: lang, ttsLanguage: lang } });
    ui.el("utterance").value = prompt;
    ui.el("utterance-form").dispatchEvent(new ui.win.Event("submit", { cancelable: true }));
    assert.deepEqual(ui.sent.at(-1).payload, { text: prompt, lang, last: true });
    ui.el("mic-start").click(); const recognition = ui.recognitions[0];
    assert.equal(recognition.lang, lang);
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: prompt } }] });
    assert.deepEqual(ui.sent.at(-1).payload, { text: prompt, lang, last: true });
    ui.el("tts").checked = true; ui.el("tts").dispatchEvent(new ui.win.Event("change"));
    ui.socket.message({ type: "session", session: { ...ui.view, language: lang, ttsLanguage: lang, transcript: [entry(reply, lang, { lang })] } });
    assert.equal(ui.el("transcript").querySelector(".message-body").textContent, reply);
    assert.equal(ui.spoken.at(-1).text, reply); assert.equal(ui.spoken.at(-1).lang, lang);
  });
}

test("manual text and transcript work without STT/TTS; UI renders untrusted text safely", (t) => {
  const ui = browser(t);
  assert.equal(ui.el("mic-start").disabled, true);
  assert.match(ui.el("speech-status").textContent, /unavailable/);
  assert.equal(ui.el("send").disabled, false);
  ui.el("utterance").value = "Mamy termin o 18:00, ale kosztuje 35 euro.";
  ui.el("utterance-form").dispatchEvent(new ui.win.Event("submit", { cancelable: true }));
  const command = ui.sent.find((message) => message.type === "utterance");
  assert.deepEqual(command.payload, { text: "Mamy termin o 18:00, ale kosztuje 35 euro.", lang: "pl-PL", last: true });
  assert.equal(ui.el("utterance").value, command.payload.text); // Keep input until successful acknowledgment.
  ui.socket.message({ type: "error", requestId: command.requestId, code: "INVALID_CALL_STATE", message: "Disconnected" });
  assert.equal(ui.el("utterance").value, command.payload.text);
  ui.el("utterance-form").dispatchEvent(new ui.win.Event("submit", { cancelable: true }));
  ui.socket.message({ type: "ack", requestId: ui.sent.at(-1).requestId });
  assert.equal(ui.el("utterance").value, "");
  ui.socket.message({ type: "session", session: { ...ui.view, transcript: [entry('<img src=x onerror="alert(1)"> Dziękuję. ')] } });
  assert.equal(ui.el("transcript").querySelector("img"), null);
  assert.equal(ui.el("transcript").querySelector(".message-body").textContent, '<img src=x onerror="alert(1)"> Dziękuję. ');
  ui.el("keypad").querySelector("button").click(); assert.deepEqual(ui.sent.at(-1).payload, { digit: "1" });
  ui.el("interrupt").click(); assert.deepEqual(ui.sent.at(-1).payload, { utteranceUntilInterrupt: "", durationUntilInterruptMs: 0 });
});

test("answer failure is visible outside diagnostics after live updates and refresh, and clears for another call", (t) => {
  const ui = browser(t);
  const failed = { ...ui.view, status: "failed", connection: "failed", relayWsUrl: "ws://localhost:3001/ws/voice",
    lastError: { code: "BACKEND_WS_CONNECT_FAILED", message: "Backend rejected the WebSocket upgrade with HTTP 404." } };
  ui.socket.message({ type: "session", session: failed });
  assert.equal(ui.el("call-failure").hidden, false);
  assert.match(ui.el("call-failure").textContent, /HTTP 404/);
  assert.match(ui.el("call-failure").textContent, /ws:\/\/localhost:3001\/ws\/voice/);
  assert.match(ui.el("call-failure").textContent, /create a new call/);
  assert.equal(ui.el("call-failure").closest("details"), null);
  assert.equal(ui.el("send").disabled, true);
  ui.socket.message({ type: "snapshot", operatorId: "browser-1", config: { language: "pl-PL", browserSpeech: true }, sessions: [failed] });
  assert.equal(ui.el("call-failure").hidden, false);
  ui.socket.message({ type: "session", session: { ...ui.view, id: "CA" + "f".repeat(32) } });
  ui.ui.select("CA" + "f".repeat(32));
  assert.equal(ui.el("call-failure").hidden, true);
  assert.equal(ui.el("call-failure").textContent, "");
});

test("streaming output is visible before final, spoken once on final, and future language changes reach speech controls", (t) => {
  const ui = browser(t, true);
  ui.el("tts").checked = true; ui.el("tts").dispatchEvent(new ui.win.Event("change"));
  ui.socket.message({ type: "session", session: { ...ui.view, transcript: [entry("Dzień ", "turn", { final: false })] } });
  assert.equal(ui.spoken.length, 0); assert.equal(ui.el("transcript").querySelector(".message-body").textContent, "Dzień ");
  ui.socket.message({ type: "session", session: { ...ui.view, transcript: [entry("Dzień dobry! ", "turn")] } });
  ui.socket.message({ type: "session", session: { ...ui.view, transcript: [entry("Dzień dobry! ", "turn")] } });
  assert.equal(ui.spoken.length, 1); assert.equal(ui.spoken[0].text, "Dzień dobry! ");
  ui.spoken[0].onend();
  ui.socket.message({ type: "session", session: { ...ui.view, language: "es-ES", ttsLanguage: "es-ES", transcript: [entry("Hola.", "next", { lang: "es-ES" })] } });
  assert.equal(ui.el("language").value, "es-ES"); assert.equal(ui.spoken.at(-1).lang, "es-ES");
  ui.spoken.at(-1).onboundary({ charIndex: 3 });
  ui.el("interrupt").click();
  assert.equal(ui.sent.at(-1).type, "interrupt"); assert.equal(ui.sent.at(-1).payload.utteranceUntilInterrupt, "Hol");
  assert.equal(typeof ui.sent.at(-1).payload.durationUntilInterruptMs, "number"); assert.ok(ui.canceled > 0);
});

test("browser recognition emits one final Polish prompt, handles denied/onend/repeated controls, and pauses for TTS", (t) => {
  const ui = browser(t, true);
  ui.el("mic-start").click(); const recognition = ui.recognitions[0]; assert.equal(recognition.lang, "pl-PL");
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: "partial" } }, { isFinal: true, 0: { transcript: "Zażółć gęślą jaźń." } }] });
  assert.equal(ui.sent.filter((message) => message.type === "utterance").length, 1);
  assert.equal(ui.sent.find((message) => message.type === "utterance").payload.text, "Zażółć gęślą jaźń.");
  ui.el("tts").checked = true; ui.el("tts").dispatchEvent(new ui.win.Event("change"));
  ui.socket.message({ type: "session", session: { ...ui.view, transcript: [entry("Odpowiedź.")] } });
  assert.equal(recognition.stopped, true);
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "own AI voice" } }] });
  assert.equal(ui.sent.filter((message) => message.type === "utterance").length, 1);
  ui.spoken[0].onend(); assert.equal(ui.recognitions.length, 2);
  ui.recognitions[1].onerror({ error: "not-allowed" });
  assert.match(ui.el("speech-status").textContent, /Typed input still works/); assert.equal(ui.el("send").disabled, false);
  ui.el("mic-stop").click(); ui.el("mic-stop").click(); ui.el("mic-start").click(); ui.recognitions.at(-1).onend();
  assert.match(ui.el("speech-status").textContent, /Microphone stopped/);
});

test("terminal state and pagehide cancel speech; refresh snapshot never replays output or answers a call", (t) => {
  const ui = browser(t, true);
  ui.el("tts").checked = true; ui.el("tts").dispatchEvent(new ui.win.Event("change"));
  ui.socket.message({ type: "session", session: { ...ui.view, transcript: [entry("Hello.")] } });
  const cancellations = ui.canceled;
  ui.socket.message({ type: "session", session: { ...ui.view, status: "completed", connection: "disconnected", transcript: [entry("Hello.")] } });
  assert.ok(ui.canceled > cancellations); assert.equal(ui.el("send").disabled, true);
  assert.equal(ui.sent.filter((command) => command.type === "answer").length, 0);
  ui.win.dispatchEvent(new ui.win.Event("pagehide")); assert.equal(ui.socket.readyState, 3);
});

test("speech helper respects non-interruptible/current preemptible flags and gives a text fallback without voices", (t) => {
  const ui = browser(t, true); const statuses = [];
  const speech = new SpeechController(ui.win, { transcript() {}, status: (message, code) => statuses.push({ message, code }) });
  speech.enabled = true; speech.speak(entry("Do not interrupt", "one", { interruptible: false }));
  assert.equal(speech.interrupt(), null); assert.match(statuses.at(-1).message, /non-interruptible/);
  speech.stop(); speech.speak(entry("Can preempt", "two", { preemptible: true }));
  const old = ui.canceled; speech.speak(entry("New output", "three")); assert.ok(ui.canceled > old);
  ui.win.speechSynthesis.getVoices = () => []; speech.speak(entry("Still visible", "four"));
  assert.equal(statuses.at(-1).code, "BROWSER_TTS_UNAVAILABLE");
  speech.stop();
});
