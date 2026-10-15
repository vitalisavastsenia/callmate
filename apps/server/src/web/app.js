export function initializeConsole(win, doc) {
  const el = (id) => doc.getElementById(id);
  const isActive = (conversation) => conversation && !["completed", "failed"].includes(conversation.status);
  let conversation = null;
  let busy = false;
  let pendingStart = null;
  let pendingStop = null;
  let cancelId = null;
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
    el("stop").disabled = Boolean(pendingStop) || cancelId === conversation?.id || !active;
    el("initial-message").disabled = busy || Boolean(active);
    el("language").disabled = busy || Boolean(active);
    if (restoreFields && conversation) {
      el("initial-message").value = conversation.initialMessage; el("language").value = conversation.language;
    }
    el("status").textContent = active && cancelId === conversation?.id ? "Stopping the mock call…" : busy ? "Working…" : conversation ? statusText[conversation.status] : loaded ? "Ready to start" : "Connecting to the backend…";
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
    if (!response.ok) {
      const error = new Error(data.error?.message || "The backend request failed."); error.status = response.status; throw error;
    }
    return data;
  }
  async function refresh(restore = false) {
    const current = generation;
    try {
      const data = await request("/api/dev/conversations");
      if (disposed || current !== generation) return;
      if (data.conversation?.conversationData === "deleted" && conversation?.id === data.conversation.id
        && el("initial-message").value === conversation.initialMessage) el("initial-message").value = "";
      conversation = data.conversation; loaded = true; notice(conversation?.error); render(restore);
      if (isActive(conversation) && cancelId === conversation.id && !pendingStop) await stopCall(conversation.id);
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
    const requestId = win.crypto.randomUUID();
    const language = el("language").value;
    busy = true; pendingStart = requestId; cancelId = null; generation++;
    conversation = { id: requestId, initialMessage, language, status: "creating", responses: [], error: null, operatorUrl: null };
    notice(""); render();
    try {
      const data = await request("/api/dev/conversations", { requestId, initialMessage, language });
      if (disposed) return;
      if (cancelId === requestId) {
        // A Stop may reach the API before Start reserves the attempt. Retry after Start is acknowledged.
        if (isActive(conversation)) await stopCall(requestId);
      } else { conversation = data.conversation; loaded = true; notice(conversation.error); }
    } catch (error) {
      if (disposed) return;
      loaded = false; notice(error.message);
    } finally { busy = false; pendingStart = null; if (!disposed) render(); }
  };
  async function stopCall(id) {
    if (pendingStop) return pendingStop;
    const job = (async () => {
      try {
        const data = await request(`/api/dev/conversations/${encodeURIComponent(id)}/stop`, {});
        if (disposed) return;
        conversation = data.conversation; loaded = true; notice(conversation.error);
      } catch (error) {
        if (disposed) return;
        // Start is still in transit; retain cancellation intent until the attempt becomes visible.
        if (!(pendingStart === id && error.status === 404)) notice(error.message);
      }
    })();
    pendingStop = job; render();
    try { await job; } finally { pendingStop = null; if (!disposed) render(); }
  }
  const stop = async () => {
    if (pendingStop || !isActive(conversation) || cancelId === conversation.id || (busy && !pendingStart)) return;
    cancelId = conversation.id; generation++; notice(""); render();
    await stopCall(conversation.id);
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
