export function initializeConsole(win, doc) {
  const el = (id) => doc.getElementById(id);
  const isActive = (conversation) => conversation && !["completed", "failed"].includes(conversation.status);
  let conversation = null;
  let busy = false;
  let loaded = false;
  let disposed = false;
  let timer;
  let generation = 0;
  const statusText = { creating: "Starting the mock call…", ringing: "Waiting for the operator to answer…", connected: "Connected · waiting for a reply",
    disconnected: "Checking the disconnected call…", completed: "Conversation ended", failed: "Conversation failed", unknown: "Call creation is unconfirmed" };
  const notice = (message) => { el("notice").textContent = message || ""; el("notice").hidden = !message; };
  function render(restoreFields = false) {
    const active = isActive(conversation);
    el("start").disabled = busy || !loaded || Boolean(active);
    el("stop").disabled = busy || !active;
    el("initial-message").disabled = busy || Boolean(active);
    el("language").disabled = busy || Boolean(active);
    if (restoreFields && conversation) {
      el("initial-message").value = conversation.initialMessage; el("language").value = conversation.language;
    }
    el("status").textContent = busy ? "Working…" : conversation ? statusText[conversation.status] : loaded ? "Ready to start" : "Connecting to the backend…";
    el("response").value = conversation?.responses.map((item) => item.text).join("\n\n") || "";
    const count = conversation?.responses.length || 0;
    el("response-meta").textContent = count ? `${count} ${count === 1 ? "reply" : "replies"} received from the operator.`
      : active ? "Answer the call in the operator window, then type a reply there." : "Waiting for a conversation.";
    el("operator-link").hidden = !conversation?.operatorUrl;
    if (conversation?.operatorUrl) el("operator-link").href = conversation.operatorUrl;
    else el("operator-link").removeAttribute("href");
  }
  async function request(path, body) {
    const response = await win.fetch(path, { ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: win.AbortSignal.timeout(6000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "The backend request failed.");
    return data;
  }
  async function refresh(restore = false) {
    const current = generation;
    try {
      const data = await request("/api/dev/conversations");
      if (disposed || current !== generation) return;
      conversation = data.conversation; loaded = true; notice(conversation?.error); render(restore);
    } catch (error) {
      if (disposed || current !== generation) return;
      loaded = false; notice(error.message || "Cannot reach the backend. Start Docker and retry."); render();
    }
  }
  async function poll() {
    if (disposed) return;
    if (!busy) await refresh();
    if (!disposed) timer = win.setTimeout(poll, 1000);
  }
  const start = async (event) => {
    event.preventDefault();
    const initialMessage = el("initial-message").value;
    if (busy || !loaded || isActive(conversation) || !initialMessage.trim()) return;
    busy = true; generation++; notice(""); render();
    try {
      const data = await request("/api/dev/conversations", { requestId: win.crypto.randomUUID(), initialMessage, language: el("language").value });
      if (disposed) return;
      conversation = data.conversation; loaded = true; notice(conversation.error);
    } catch (error) {
      if (disposed) return;
      loaded = false; notice(error.message);
    } finally { busy = false; if (!disposed) render(); }
  };
  const stop = async () => {
    if (busy || !isActive(conversation)) return;
    busy = true; generation++; notice(""); render();
    try {
      const data = await request(`/api/dev/conversations/${encodeURIComponent(conversation.id)}/stop`, {});
      if (disposed) return;
      conversation = data.conversation; notice(conversation.error);
    } catch (error) { if (!disposed) notice(error.message); }
    finally { busy = false; if (!disposed) render(); }
  };
  el("conversation-form").addEventListener("submit", start);
  el("stop").addEventListener("click", stop);
  const cleanup = () => { disposed = true; win.clearTimeout(timer); el("conversation-form").removeEventListener("submit", start); el("stop").removeEventListener("click", stop); };
  win.addEventListener("pagehide", cleanup, { once: true });
  render();
  const ready = refresh(true).then(() => { if (!disposed) timer = win.setTimeout(poll, 1000); });
  return { cleanup, ready, refresh };
}
if (typeof window !== "undefined") initializeConsole(window, document);
