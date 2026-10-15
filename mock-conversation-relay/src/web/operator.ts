import type { LogEvent, PublicConfig, SessionView } from "../shared/types.js";
import { SpeechController } from "./speech.js";

const terminal = new Set(["completed", "busy", "canceled", "no-answer", "failed"]);
type Browser = Window & { WebSocket: typeof WebSocket; fetch: typeof fetch; URL: typeof URL; Blob: typeof Blob };

export function initializeOperator(win: Browser, doc: Document) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => {
    const element = doc.getElementById(id); if (!element) throw new Error(`Missing UI element: ${id}`); return element as T;
  };
  const sessions = new Map<string, SessionView>();
  const seenSpeech = new Set<string>();
  const seenCancel = new Set<string>();
  const pendingUtterances = new Map<string, string>();
  let selected = new URL(win.location.href).searchParams.get("callId");
  let operatorId = "";
  let config: PublicConfig | null = null;
  let socket: WebSocket | null = null;
  let disposed = false;
  let reconnect: number | undefined;
  let serial = 0;
  let claimedSelection: string | null = null;
  const showError = (message: string) => { el("notice").textContent = message; el("notice").hidden = false; };
  const clearError = () => { el("notice").hidden = true; };
  const active = () => selected ? sessions.get(selected) : undefined;
  const controlsOwned = () => active()?.operatorId === operatorId && Boolean(operatorId);
  const send = (type: string, extra: object = {}, callSid = selected) => {
    if (!callSid || socket?.readyState !== win.WebSocket.OPEN) { showError("Operator channel is disconnected. Input was not sent; reconnect and retry."); return false; }
    const requestId = String(++serial);
    socket.send(JSON.stringify({ type, callSid, requestId, ...extra })); return requestId;
  };
  const speech = new SpeechController(win, {
    transcript: (text) => { if (controlsOwned() && active()?.connection === "connected") send("utterance", { payload: { text, lang: el<HTMLSelectElement>("language").value, last: true } }); },
    status: (message, code) => {
      el("speech-status").textContent = message;
      if (code && controlsOwned()) send("speech-status", { code, message });
    },
  });
  const text = (id: string, value: string) => { el(id).textContent = value; };
  const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const optionLanguage = (id: string, value: string) => {
    const select = el<HTMLSelectElement>(id);
    if (![...select.options].some((option) => option.value === value)) { const option = doc.createElement("option"); option.value = value; option.textContent = value; select.append(option); }
    select.value = value;
  };
  function select(id: string) {
    if (selected && selected !== id && controlsOwned()) send("release");
    speech.stop(); selected = id; claimedSelection = null;
    win.history.replaceState(null, "", `/?callId=${encodeURIComponent(id)}`);
    render();
  }
  function renderList() {
    const list = el("calls"); list.replaceChildren();
    const entries = [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    text("count", String(entries.filter((session) => !terminal.has(session.status)).length));
    if (!entries.length) { const empty = doc.createElement("p"); empty.className = "empty-list"; empty.textContent = "Waiting for a mock call…"; list.append(empty); }
    for (const session of entries) {
      const button = doc.createElement("button"); button.className = `call-card${selected === session.id ? " selected" : ""}`;
      const top = doc.createElement("div"); top.className = "call-card-top";
      const status = doc.createElement("span"); status.className = "status-badge"; status.dataset.status = session.status; status.textContent = session.status;
      const age = doc.createElement("small"); age.textContent = time(session.createdAt); top.append(status, age);
      const to = doc.createElement("strong"); to.textContent = session.to;
      const task = doc.createElement("span"); task.className = "mono muted"; task.textContent = session.customParameters.taskId ?? session.id.slice(0, 18) + "…";
      button.append(top, to, task); button.addEventListener("click", () => select(session.id)); list.append(button);
    }
  }
  function render() {
    renderList();
    const session = active();
    el("conversation").hidden = !session; el("empty").hidden = Boolean(session);
    if (!session) return;
    text("call-title", `Call to ${session.to}`); text("call-meta", `FROM ${session.from}`);
    text("call-status", session.status); el("call-status").dataset.status = session.status;
    el("call-failure").hidden = session.status !== "failed";
    text("call-failure", session.status === "failed"
      ? `${session.lastError?.code ?? "CALL_FAILED"}: ${session.lastError?.message ?? "The call failed."}${session.lastError?.code === "BACKEND_WS_CONNECT_FAILED"
        ? ` Destination: ${session.relayWsUrl ?? "configured backend"}. Once the backend handler is available, create a new call; failed calls cannot be answered again.` : ""}` : "");
    text("connection", session.connection); el("connection").dataset.state = session.connection;
    text("age", `Session age ${Math.max(0, Math.floor((Date.now() - Date.parse(session.createdAt)) / 1000))}s`);
    const own = controlsOwned();
    text("ownership", own ? "You control this call" : session.operatorId ? "Another tab has the controls" : "Controls available");
    el("claim").hidden = own; el("release").hidden = !own;
    // Claim without answering: refreshing/reconnecting the operator never creates a backend connection.
    if (!session.operatorId && operatorId && claimedSelection !== session.id) { claimedSelection = session.id; send("claim"); }
    el("ringing").hidden = session.status !== "ringing";
    el<HTMLButtonElement>("answer").disabled = !own; el<HTMLButtonElement>("reject").disabled = !own;
    const ready = own && session.connection === "connected" && session.status === "in-progress" && socket?.readyState === win.WebSocket.OPEN;
    for (const id of ["send", "utterance", "language", "partial", "interrupt", "mic-start", "mic-stop"]) el<HTMLButtonElement>(id).disabled = !ready;
    el<HTMLButtonElement>("mic-start").disabled = !ready || !config?.browserSpeech || !speech.recognitionAvailable;
    el<HTMLButtonElement>("hangup").disabled = !own || terminal.has(session.status);
    el<HTMLButtonElement>("delete-call").disabled = !terminal.has(session.status) || Boolean(session.operatorId && !own);
    for (const button of el("keypad").querySelectorAll("button")) button.disabled = !ready;
    optionLanguage("language", session.language); speech.language = session.language;
    const transcript = el("transcript"); const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
    transcript.replaceChildren();
    if (!session.transcript.length) { const empty = doc.createElement("p"); empty.className = "transcript-empty"; empty.textContent = "The conversation will appear here. Caller input is sent to your backend over the relay socket."; transcript.append(empty); }
    for (const message of session.transcript) {
      const item = doc.createElement("article"); item.className = `message ${message.speaker}${message.final ? "" : " streaming"}`;
      const label = doc.createElement("div"); label.className = "message-label";
      label.append(doc.createTextNode(message.speaker === "operator" ? "YOU · BUSINESS" : message.speaker === "platform" ? "SIMULATED PLATFORM GREETING" : "CALLMATE AI"));
      const stamp = doc.createElement("time"); stamp.dateTime = message.at; stamp.textContent = time(message.at) + (message.final ? "" : " · partial"); label.append(stamp);
      const body = doc.createElement("div"); body.className = "message-body"; body.textContent = message.text;
      item.append(label, body); transcript.append(item);
    }
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
    text("destination", session.relayWsUrl ?? "Resolved when answered"); text("sid", session.id); text("session-id", session.sessionId ?? "Not connected");
    text("last-error", [session.lastError ? `${session.lastError.code}: ${session.lastError.message}` : "No error", session.lastClose ? `Close ${session.lastClose.code}: ${session.lastClose.reason}` : ""].filter(Boolean).join(" · "));
    text("handoff", session.handoffData ?? "None"); text("events", JSON.stringify({ mockGenerated: true, droppedEvents: session.droppedEvents, events: session.events }, null, 2));
    if (!ready) speech.stop();
  }
  function acceptSession(session: SessionView, live: boolean) {
    sessions.set(session.id, session);
    if (!selected) { selected = session.id; win.history.replaceState(null, "", `/?callId=${session.id}`); }
    const shouldSpeak = live && selected === session.id && session.operatorId === operatorId && session.status === "in-progress";
    for (const entry of session.transcript) if (entry.final && !seenSpeech.has(entry.id)) {
      seenSpeech.add(entry.id); if (shouldSpeak && entry.speaker !== "operator") speech.speak(entry);
    }
    for (const event of session.events) if (event.type === "playback.cancel") {
      const key = `${session.id}:${event.sequence}`;
      if (!seenCancel.has(key)) { seenCancel.add(key); if (live && selected === session.id) speech.cancelPlayback(); }
    }
  }
  function connect() {
    if (disposed) return;
    socket = new win.WebSocket(`${win.location.protocol === "https:" ? "wss:" : "ws:"}//${win.location.host}/operator`);
    socket.addEventListener("open", () => { text("channel", "● Operator connected"); clearError(); });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "snapshot") {
          sessions.clear(); operatorId = message.operatorId; config = message.config; claimedSelection = null;
          for (const session of message.sessions) acceptSession(session, false);
          el<HTMLInputElement>("from").value ||= config!.from; el<HTMLInputElement>("to").value ||= config!.to;
          el<HTMLInputElement>("relay-url").value ||= config!.relayWsUrl; optionLanguage("create-language", config!.language);
          speech.enabled = el<HTMLInputElement>("tts").checked && config!.browserSpeech;
          if (!speech.recognitionAvailable) text("speech-status", "Microphone recognition is unavailable in this browser. Typed input works without it.");
        } else if (message.type === "session") acceptSession(message.session, true);
        else if (message.type === "deleted") { sessions.delete(message.id); if (selected === message.id) { speech.stop(); selected = null; } }
        else if (message.type === "ack") {
          const original = pendingUtterances.get(message.requestId);
          if (original !== undefined && el<HTMLTextAreaElement>("utterance").value === original) el<HTMLTextAreaElement>("utterance").value = "";
          pendingUtterances.delete(message.requestId);
        } else if (message.type === "error") { pendingUtterances.delete(message.requestId); showError(`${message.code}: ${message.message}`); }
        render();
      } catch { showError("Cannot read an operator update. Reconnect to reload the session snapshot."); }
    });
    socket.addEventListener("error", () => showError("Operator channel unavailable. The backend relay is separate; no call has been restarted."));
    socket.addEventListener("close", () => { if (disposed) return; operatorId = ""; claimedSelection = null; pendingUtterances.clear(); speech.stop(); render(); text("channel", "○ Reconnecting operator…"); reconnect = win.setTimeout(connect, 1500); });
  }
  function openCreate() { el("create-panel").hidden = false; el<HTMLInputElement>("task-id").focus(); }
  for (const id of ["new-call", "empty-create"]) el(id).addEventListener("click", openCreate);
  el("close-create").addEventListener("click", () => { el("create-panel").hidden = true; });
  async function request(path: string, options: RequestInit) {
    const response = await win.fetch(path, { ...options, headers: { "content-type": "application/json", "x-operator-id": operatorId, ...options.headers } });
    if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message ?? `HTTP ${response.status}`); }
    return response.status === 204 ? null : response.json();
  }
  el("create-form").addEventListener("submit", (event) => {
    event.preventDefault(); clearError();
    void request("/api/sessions", { method: "POST", body: JSON.stringify({ to: el<HTMLInputElement>("to").value, from: el<HTMLInputElement>("from").value,
      language: el<HTMLSelectElement>("create-language").value, relayWsUrl: el<HTMLInputElement>("relay-url").value,
      customParameters: { taskId: el<HTMLInputElement>("task-id").value || "task-demo-001" } }) })
      .then((session) => { acceptSession(session, false); select(session.id); el("create-panel").hidden = true; }).catch((error: Error) => showError(error.message));
  });
  for (const action of ["answer", "reject", "hangup", "claim", "release"] as const) el(action).addEventListener("click", () => {
    clearError();
    if (action === "hangup" || action === "release") speech.stop();
    if (action === "release") claimedSelection = selected;
    send(action);
  });
  el("utterance-form").addEventListener("submit", (event) => {
    event.preventDefault(); const field = el<HTMLTextAreaElement>("utterance");
    if (!field.value.trim()) return;
    const requestId = send("utterance", { payload: { text: field.value, lang: el<HTMLSelectElement>("language").value, last: !el<HTMLInputElement>("partial").checked } });
    if (requestId) pendingUtterances.set(requestId, field.value);
  });
  el("language").addEventListener("change", () => { speech.stopMic(); speech.language = el<HTMLSelectElement>("language").value; send("language", { language: speech.language }); });
  el("mic-start").addEventListener("click", () => speech.startMic()); el("mic-stop").addEventListener("click", () => speech.stopMic());
  el("interrupt").addEventListener("click", () => { const payload = speech.interrupt(); if (payload) send("interrupt", { payload }); });
  el("tts").addEventListener("change", () => { speech.enabled = el<HTMLInputElement>("tts").checked && Boolean(config?.browserSpeech); if (!speech.enabled) speech.cancelPlayback(); });
  el("volume").addEventListener("input", () => { speech.volume = Number(el<HTMLInputElement>("volume").value); });
  el("voice").addEventListener("change", () => { speech.voiceURI = el<HTMLSelectElement>("voice").value; });
  const voicesChanged = () => {
    const select = el<HTMLSelectElement>("voice"); select.replaceChildren();
    const defaultOption = doc.createElement("option"); defaultOption.value = ""; defaultOption.textContent = "System default"; select.append(defaultOption);
    for (const voice of speech.voices()) { const option = doc.createElement("option"); option.value = voice.voiceURI; option.textContent = `${voice.name} (${voice.lang})`; select.append(option); }
    select.value = speech.voiceURI;
  };
  win.speechSynthesis?.addEventListener("voiceschanged", voicesChanged); voicesChanged();
  for (const digit of "123456789*0#") { const button = doc.createElement("button"); button.textContent = digit; button.type = "button";
    button.addEventListener("click", () => send("dtmf", { payload: { digit } })); el("keypad").append(button); }
  const exportLog = async () => {
    if (!selected) throw new Error("Select a call first");
    return JSON.stringify(await request(`/api/sessions/${selected}/events`, { method: "GET" }), null, 2);
  };
  el("copy-log").addEventListener("click", () => { void exportLog().then((log) => win.navigator.clipboard.writeText(log)).then(() => text("copy-log", "Copied JSON")).catch(() => showError("Clipboard unavailable. Use Download JSON instead.")); });
  el("download-log").addEventListener("click", () => { void exportLog().then((log) => {
    const url = win.URL.createObjectURL(new win.Blob([log], { type: "application/json" }));
    const link = doc.createElement("a"); link.href = url; link.download = `mock-${selected}.json`; link.click(); win.URL.revokeObjectURL(url);
  }).catch((error: Error) => showError(error.message)); });
  el("delete-call").addEventListener("click", () => { if (selected) void request(`/api/sessions/${selected}`, { method: "DELETE" }).catch((error: Error) => showError(error.message)); });
  const ageTimer = win.setInterval(() => { if (active()) text("age", `Session age ${Math.max(0, Math.floor((Date.now() - Date.parse(active()!.createdAt)) / 1000))}s`); }, 1000);
  const cleanup = () => { disposed = true; win.clearTimeout(reconnect); win.clearInterval(ageTimer); speech.stop(); socket?.close(); win.speechSynthesis?.removeEventListener("voiceschanged", voicesChanged); };
  win.addEventListener("pagehide", cleanup); connect();
  return { cleanup, speech, sessions, select };
}
