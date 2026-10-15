import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { WebSocket } from "ws";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { callStatus, relayOutbound, terminal } from "./protocol.js";
import type { CallStatus, RelayInbound, RelayOutbound } from "./protocol.js";
import { createServer, formType, listen, mockAccountSid, mockAuthToken, postSigned, readForm,
  requireLoopback, signed, stop } from "./local-http.js";

type MockCall = {
  sid: string; fields: Record<string, string>; subscriptions: string[]; status: CallStatus;
  created: string; started: string | null; ended: string | null; sequence: number;
  ws?: WebSocket; sessionId?: string; action?: string; sessionStarted?: number;
  received: RelayOutbound[]; malformed: number; finishing: boolean;
};
const sid = (prefix: string) => prefix + randomBytes(16).toString("hex");
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
function error(res: ServerResponse, status: number, code: number, message: string) {
  json(res, status, { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status });
}

/** Local protocol double, not an emulator of Twilio's carrier or speech infrastructure. */
export class TwilioMock {
  baseUrl = "";
  readonly calls = new Map<string, MockCall>();
  readonly requests: { method: string; path: string; fields: Record<string, string | string[]> }[] = [];
  readonly failures: string[] = [];
  private server = createServer((req, res) => { void this.handle(req, res).catch(() => error(res, 400, 20001, "Unsupported local mock request")); });

  async start() { this.baseUrl = await listen(this.server); return this; }
  async close() {
    for (const call of this.calls.values()) call.ws?.terminate();
    await stop(this.server);
  }
  private resource(call: MockCall) {
    const uri = `/2010-04-01/Accounts/${mockAccountSid}/Calls/${call.sid}.json`;
    return { sid: call.sid, account_sid: mockAccountSid, status: call.status,
      to: call.fields.To, from: call.fields.From, to_formatted: call.fields.To, from_formatted: call.fields.From,
      date_created: call.created, date_updated: call.ended ?? call.started ?? call.created,
      start_time: call.started, end_time: call.ended, duration: call.ended && call.sessionStarted
        ? String(Math.floor((Date.now() - call.sessionStarted) / 1000)) : null,
      price: null, price_unit: "USD", direction: "outbound-api", answered_by: null,
      forwarded_from: null, parent_call_sid: null, phone_number_sid: null,
      api_version: "2010-04-01", uri, subresource_uris: { recordings: uri.replace(".json", "/Recordings.json") },
      queue_time: "0" };
  }
  private async handle(req: import("node:http").IncomingMessage, res: ServerResponse) {
    const authorization = `Basic ${Buffer.from(`${mockAccountSid}:${mockAuthToken}`).toString("base64")}`;
    if (req.headers.authorization !== authorization) return error(res, 401, 20003, "Authenticate");
    const path = new URL(req.url!, this.baseUrl).pathname;
    const root = `/2010-04-01/Accounts/${mockAccountSid}/Calls`;
    const fields = req.method === "POST" ? await readForm(req) : {};
    this.requests.push({ method: req.method!, path, fields });
    if (path === `${root}.json` && req.method === "POST") {
      if (!fields.To) return error(res, 400, 21201, "No 'To' number is specified");
      if (typeof fields.To !== "string" || !/^\+[1-9]\d{7,14}$/.test(fields.To)) return error(res, 400, 21211, "Invalid 'To' Phone Number");
      if (typeof fields.From !== "string" || !/^\+[1-9]\d{7,14}$/.test(fields.From)) return error(res, 400, 21212, "Invalid 'From' Number");
      // Only the declared subset is accepted. No real numbers are dialed.
      const supported = new Set(["To", "From", "Url", "Method", "StatusCallback", "StatusCallbackMethod", "StatusCallbackEvent", "TimeLimit", "Timeout", "Record"]);
      if (Object.keys(fields).some((name) => !supported.has(name)) || fields.Method !== "POST"
        || fields.StatusCallbackMethod !== "POST" || fields.Record !== "false") throw new Error("Unsupported options");
      requireLoopback(String(fields.Url)); requireLoopback(String(fields.StatusCallback));
      const events = fields.StatusCallbackEvent === undefined ? ["completed"]
        : Array.isArray(fields.StatusCallbackEvent) ? fields.StatusCallbackEvent : [fields.StatusCallbackEvent];
      if (events.some((event) => !["initiated", "ringing", "answered", "completed"].includes(event))) throw new Error("Unsupported subscription");
      if (Object.entries(fields).some(([name, value]) => name !== "StatusCallbackEvent" && Array.isArray(value))) throw new Error("Repeated field");
      const call: MockCall = { sid: sid("CA"), fields: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "StatusCallbackEvent")) as Record<string, string>,
        subscriptions: events, status: "queued", created: new Date().toUTCString(), started: null, ended: null,
        sequence: 0, received: [], malformed: 0, finishing: false };
      this.calls.set(call.sid, call);
      return json(res, 201, this.resource(call));
    }
    const call = [...this.calls.values()].find((item) => path === `${root}/${item.sid}.json`);
    if (!call) return error(res, 404, 20404, "The requested resource was not found");
    if (req.method === "GET") return json(res, 200, this.resource(call));
    if (req.method === "POST") {
      if (Object.keys(fields).length !== 1 || !["completed", "canceled"].includes(String(fields.Status))) throw new Error("Unsupported update");
      if (fields.Status === "canceled" && !["queued", "ringing"].includes(call.status)) throw new Error("Call cannot be canceled");
      const queuedCancel = call.status === "queued" && fields.Status === "canceled";
      if (queuedCancel) { call.status = "canceled"; call.ended = new Date().toUTCString(); }
      else await this.finish(call.sid, fields.Status as "completed" | "canceled");
      return json(res, 200, this.resource(call));
    }
    error(res, 404, 20404, "The requested resource was not found");
  }
  private get(id: string) {
    const call = this.calls.get(id);
    if (!call) throw new Error("Unknown mock call");
    return call;
  }
  callbackFields(id: string, status: CallStatus | "initiated", sequence: number): Record<string, string> {
    const call = this.get(id);
    return { AccountSid: mockAccountSid, CallSid: id, From: call.fields.From!, To: call.fields.To!,
      Direction: "outbound-api", ApiVersion: "2010-04-01", CallStatus: status,
      CallbackSource: "call-progress-events", SequenceNumber: String(sequence), Timestamp: new Date().toUTCString(),
      ...(terminal.has(status) ? { CallDuration: "0" } : {}) };
  }
  /** Also useful for replaying duplicate/out-of-order signed provider deliveries. */
  async deliverStatus(id: string, status: CallStatus | "initiated", sequence: number) {
    const call = this.get(id);
    return postSigned(call.fields.StatusCallback!, this.callbackFields(id, status, sequence));
  }
  async progress(id: string, status: CallStatus | "initiated") {
    const call = this.get(id);
    if (terminal.has(call.status)) return;
    call.status = status === "initiated" ? "queued" : callStatus.parse(status);
    if (status === "in-progress") call.started = new Date().toUTCString();
    if (terminal.has(status)) call.ended = new Date().toUTCString();
    const event = status === "in-progress" ? "answered" : terminal.has(status) ? "completed" : status;
    if (call.subscriptions.includes(event)) await this.deliverStatus(id, status, call.sequence++);
  }
  async connectRelay(id: string) {
    const call = this.get(id);
    if (call.status !== "in-progress" || call.ws) throw new Error("Call is not ready for a relay session");
    const response = await postSigned(call.fields.Url!, { AccountSid: mockAccountSid, CallSid: id,
      From: call.fields.From!, To: call.fields.To!, CallStatus: "in-progress", Direction: "outbound-api", ApiVersion: "2010-04-01" });
    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) throw new Error("Invalid TwiML");
    const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseAttributeValue: false }).parse(xml);
    const connect = document.Response?.Connect;
    const relay = connect?.ConversationRelay;
    if (!relay || typeof relay["@url"] !== "string" || typeof connect["@action"] !== "string") throw new Error("Expected Connect/ConversationRelay");
    const url = relay["@url"] as string;
    requireLoopback(url, "ws:"); requireLoopback(connect["@action"]);
    const parameters = relay.Parameter ? Array.isArray(relay.Parameter) ? relay.Parameter : [relay.Parameter] : [];
    const customParameters: Record<string, string> = {};
    for (const parameter of parameters) customParameters[parameter["@name"]] = parameter["@value"];
    call.sessionId = sid("VX"); call.action = connect["@action"]; call.sessionStarted = Date.now();
    const ws = new WebSocket(url, { headers: { "X-Twilio-Signature": signed(url, {}) }, handshakeTimeout: 3000, maxPayload: 32768 });
    call.ws = ws;
    ws.on("error", () => { this.failures.push("WebSocket transport failed"); });
    ws.on("message", (data) => {
      try {
        const parsed = relayOutbound.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) throw new Error("Invalid frame");
        call.malformed = 0;
        call.received.push(parsed.data);
        if (parsed.data.type === "end") void this.finish(id, "completed", "ended", parsed.data.handoffData).catch(() => this.failures.push("End callback failed"));
      } catch {
        this.send(id, { type: "error", description: "Invalid message received: unsupported or malformed message (64107)" });
        if (++call.malformed >= 10) ws.close(1007, "Too many consecutive malformed messages.");
      }
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    this.send(id, { type: "setup", sessionId: call.sessionId, accountSid: mockAccountSid, callSid: id,
      from: call.fields.From!, to: call.fields.To!, parentCallSid: "", forwardedFrom: "", callType: "PSTN",
      callerName: "", direction: "outbound-api", callStatus: "IN_PROGRESS", customParameters });
    return call.sessionId;
  }
  send(id: string, message: RelayInbound) {
    const ws = this.get(id).ws;
    if (ws?.readyState !== WebSocket.OPEN) throw new Error("Relay is not open");
    ws.send(JSON.stringify(message));
  }
  /** Caller hangup, or app end followed by the Hangup returned by the action URL. */
  async finish(id: string, status: CallStatus = "completed", sessionStatus = "completed", handoffData?: string) {
    const call = this.get(id);
    if (call.finishing || terminal.has(call.status)) return;
    call.finishing = true;
    try {
      if (call.action && call.sessionId) {
        const response = await postSigned(call.action, { AccountSid: mockAccountSid, CallSid: id,
          From: call.fields.From!, To: call.fields.To!, Direction: "outbound-api",
          CallStatus: sessionStatus === "ended" ? "in-progress" : "completed",
          SessionId: call.sessionId, SessionStatus: sessionStatus,
          SessionDuration: String(Math.floor((Date.now() - call.sessionStarted!) / 1000)),
          ...(handoffData === undefined ? {} : { HandoffData: handoffData }) });
        const xml = await response.text();
        if (XMLValidator.validate(xml) !== true || !new XMLParser().parse(xml).Response?.hasOwnProperty("Hangup")) throw new Error("Expected Hangup action response");
      }
      await this.progress(id, status);
      call.ws?.close(1000);
    } finally { call.finishing = false; }
  }
}
