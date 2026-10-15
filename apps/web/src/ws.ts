// Kept at the original client boundary; v1 transport is SSE, not WebSocket.
import { ApiError, getCall, isMockMode, openCallEvents } from './api';
import { DomainEventSchema, type CallSnapshot, type ConnectionState } from './types';

export interface StreamHandlers {
  onSnapshot: (call: CallSnapshot) => void;
  onConnection: (state: ConnectionState) => void;
  onError: (message: string) => void;
  onApprovalResolved?: (resolution: { approvalId: string; status: 'approved' | 'rejected' | 'expired' | 'invalidated' }) => void;
  onConversationDeleted?: () => void;
}
export function callIsTerminal(call: CallSnapshot): boolean {
  return ['ended', 'busy', 'no_answer', 'failed'].includes(call.callState);
}

export function parseFrame(frame: string): { type: string; data: string; id: string | undefined } {
  let type = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') type = value;
    if (field === 'id') id = value;
    if (field === 'data') data.push(value);
  }
  return { type, data: data.join('\n'), id };
}

export function subscribeToCall(id: string, handlers: StreamHandlers): () => void {
  const controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  let cursor = 0;
  let revision = 0;
  let failures = 0;
  async function snapshot() {
    const call = await getCall(id);
    if (stopped) return null;
    if (call.revision < revision || call.lastEventSequence < cursor) throw new Error('The call snapshot is stale. Resynchronizing.');
    cursor = call.lastEventSequence; revision = call.revision;
    handlers.onSnapshot(call);
    return call;
  }
  async function connect() {
    if (stopped) return;
    handlers.onConnection(failures ? 'reconnecting' : 'connecting');
    try {
      const call = await snapshot();
      if (!call || callIsTerminal(call)) { if (!stopped) handlers.onConnection('closed'); return; }
      if (isMockMode) {
        handlers.onConnection('connected');
        poll = setInterval(() => {
          void snapshot().then(next => {
            if (next && callIsTerminal(next)) { clearInterval(poll); handlers.onConnection('closed'); }
          }).catch(error => { clearInterval(poll); reconnect(error); });
        }, 200);
        return;
      }
      const response = await openCallEvents(id, cursor, controller.signal);
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('The call event stream is unavailable.');
      if (stopped) { await response.body.cancel(); return; }
      handlers.onConnection('connected');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        // Normalize CRLF only once complete; tolerate CR/LF split across chunks.
        buffer = buffer.replace(/\r\n/g, '\n');
        if (buffer.length > 1_000_000) throw new Error('The event stream sent an oversized update.');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = parseFrame(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
          if (!frame.data) continue;
          if (frame.type === 'reset') throw new Error('Resynchronizing call updates.');
          if (frame.type !== 'callmate') throw new Error('Unsupported call event type.');
          const event = DomainEventSchema.parse(JSON.parse(frame.data));
          if (event.attemptId !== id || frame.id !== String(event.sequence)) throw new Error('Call update identity mismatch.');
          if (event.sequence <= cursor) continue;
          if (event.sequence !== cursor + 1) throw new Error('Call updates were missed. Resynchronizing.');
          cursor = event.sequence;
          if (event.type === 'approval.resolved') handlers.onApprovalResolved?.(event.payload);
          if (event.type === 'conversation.deleted') handlers.onConversationDeleted?.();
          if (event.type === 'call.error') handlers.onError(event.payload.message);
          if (event.snapshotRevision > revision) {
            const next = await snapshot();
            if (!next || callIsTerminal(next)) { handlers.onConnection('closed'); await reader.cancel(); return; }
          }
          failures = 0;
        }
      }
      throw new Error('The connection ended. Reconnecting to the same call.');
    } catch (error) { if (!stopped) reconnect(error); }
    finally { reader?.releaseLock(); reader = undefined; }
  }
  function reconnect(error: unknown) {
    if (stopped) return;
    handlers.onConnection('reconnecting');
    handlers.onError(error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE' ? error.message : failures >= 2 ? 'Call updates remain unavailable or incompatible. The booking outcome is not known. Keep this call open and check with the business before retrying.' : error instanceof Error ? error.message : 'Reconnecting to the current call.');
    retry = setTimeout(() => void connect(), Math.min(1000 * 2 ** Math.min(failures++, 4), 15_000));
  }
  void connect();
  return () => {
    stopped = true; controller.abort(); clearTimeout(retry); clearInterval(poll);
    void reader?.cancel().catch(() => {});
  };
}
