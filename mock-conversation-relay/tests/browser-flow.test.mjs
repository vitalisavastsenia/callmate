import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { WebSocket } from "ws";
import { initializeOperator } from "../dist/web/operator.js";
import { backend, service, until } from "./helpers.mjs";

test("served operator UI answers a Calls-created call, sends Polish text, renders streamed reply and hangs up over real sockets", async (t) => {
  const target = await backend(t); const local = await service(t, target);
  const response = await fetch(local.origin + "/"); assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  const html = await response.text();
  for (const asset of ["app.js", "operator.js", "speech.js", "styles.css"]) {
    const result = await fetch(local.origin + "/assets/" + asset); assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type"), asset.endsWith("css") ? /text\/css/ : /text\/javascript/);
  }
  const win = new Window({ url: local.origin, settings: { disableJavaScriptEvaluation: true,
    disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  win.document.write(html.replace(/<script[^>]*>.*?<\/script>/gs, ""));
  Object.defineProperty(win, "WebSocket", { value: WebSocket, configurable: true });
  Object.defineProperty(win, "fetch", { value: (path, options) => fetch(new URL(path, local.origin), options), configurable: true });
  const spoken = [];
  const synthesis = new win.EventTarget();
  synthesis.getVoices = () => [{ voiceURI: "polski", name: "Polski", lang: "pl-PL" }];
  synthesis.speak = (utterance) => spoken.push(utterance); synthesis.cancel = () => {};
  Object.defineProperty(win, "speechSynthesis", { value: synthesis, configurable: true });
  Object.defineProperty(win, "SpeechSynthesisUtterance", { value: class { constructor(text) { this.text = text; } }, configurable: true });
  const ui = initializeOperator(win, win.document);
  t.after(() => { ui.cleanup(); win.happyDOM.abort(); });
  const el = (id) => win.document.getElementById(id);
  await until(() => el("channel").textContent.includes("connected"));
  const created = await local.form(local.root + ".json", { To: "+48111222333", From: "+48000111222", Twiml: target.xml });
  const id = created.body.sid;
  await until(() => !el("answer").disabled && el("calls").textContent.includes("ringing"));
  el("answer").click(); await target.setup(id);
  await until(() => !el("send").disabled);
  const callerText = "Mamy termin o 18:00, ale kosztuje 35 euro.";
  el("utterance").value = callerText;
  el("utterance-form").dispatchEvent(new win.Event("submit", { cancelable: true }));
  await until(() => target.messages.some((entry) => entry.message.type === "prompt"));
  assert.deepEqual(target.messages.find((entry) => entry.message.type === "prompt").message,
    { type: "prompt", voicePrompt: callerText, lang: "pl-PL", last: true });
  target.send(id, { type: "text", token: "Dziękuję. ", last: false });
  target.send(id, { type: "text", token: "Czy jest tańsza opcja?", last: true });
  await until(() => el("transcript").textContent.includes("Czy jest tańsza opcja?"));
  assert.equal([...el("transcript").querySelectorAll(".assistant .message-body")].at(-1).textContent, "Dziękuję. Czy jest tańsza opcja?");
  assert.equal(spoken.length, 0);
  el("transcript").querySelector(".assistant .listen-message").click();
  assert.equal(spoken.length, 1); assert.equal(spoken[0].text, "Dziękuję. Czy jest tańsza opcja?");
  assert.equal(spoken[0].lang, "pl-PL"); assert.equal(el("tts").checked, false);
  assert.equal(el("utterance").value, "");
  el("hangup").click(); await until(() => el("call-status").textContent === "completed");
  assert.equal(el("send").disabled, true); assert.equal(target.connections, 1);
  assert.equal(target.messages.filter((entry) => entry.message.type === "setup").length, 1);
  assert.equal(local.controller.view(id).transcript.some((entry) => entry.speaker === "operator" && entry.text === callerText), true);
  assert.equal(JSON.stringify(local.controller.view(id)).includes('"booked"'), false);
});
