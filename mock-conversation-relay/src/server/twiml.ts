import { XMLParser, XMLValidator } from "fast-xml-parser";
import { backendUrl, language, MockError } from "./config.js";
import type { Config } from "./config.js";
import { parameters } from "../protocol/schemas.js";
import { requestSignature } from "./signature.js";

export type RelaySettings = { url: string; language: string; ttsLanguage: string; greeting: string;
  interruptible: boolean; customParameters: Record<string, string>; action?: string; actionMethod: "GET" | "POST" };
export function parseTwiml(xml: string, config: Config, fallbackLanguage: string): RelaySettings {
  if (Buffer.byteLength(xml) > 16_384 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new MockError("INVALID_TWIML", "TwiML must be bounded XML without DTDs or entity declarations");
  }
  let document;
  try { document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseAttributeValue: false,
    processEntities: true, htmlEntities: false, trimValues: false }).parse(xml); }
  catch { throw new MockError("INVALID_TWIML", "Cannot parse TwiML"); }
  const response = document.Response;
  const connect = response?.Connect;
  const relay = connect?.ConversationRelay;
  const childKeys = (value: object) => Object.keys(value).filter((key) => !key.startsWith("@") && key !== "#text");
  if (!response || Array.isArray(response) || !connect || Array.isArray(connect) || !relay || Array.isArray(relay)
    || childKeys(response).some((key) => key !== "Connect") || childKeys(connect).some((key) => key !== "ConversationRelay")
    || childKeys(relay).some((key) => key !== "Parameter")) {
    throw new MockError("UNSUPPORTED_TWIML", "Expected one Response/Connect/ConversationRelay structure");
  }
  const url = relay["@url"];
  if (typeof url !== "string") throw new MockError("INVALID_TWIML", "ConversationRelay url is required");
  backendUrl(url, config, "ws");
  const rawParameters = relay.Parameter === undefined ? [] : Array.isArray(relay.Parameter) ? relay.Parameter : [relay.Parameter];
  const customParameters: Record<string, string> = Object.create(null);
  for (const parameter of rawParameters) {
    if (typeof parameter["@name"] !== "string" || typeof parameter["@value"] !== "string"
      || Object.hasOwn(customParameters, parameter["@name"])) throw new MockError("INVALID_TWIML", "Invalid or duplicate Parameter");
    customParameters[parameter["@name"]] = parameter["@value"];
  }
  const parsedParameters = parameters.safeParse(customParameters);
  const stt = language.safeParse(relay["@transcriptionLanguage"] ?? relay["@language"] ?? fallbackLanguage);
  const tts = language.safeParse(relay["@ttsLanguage"] ?? relay["@language"] ?? fallbackLanguage);
  if (!parsedParameters.success || !stt.success || !tts.success) throw new MockError("INVALID_TWIML", "Invalid language or custom parameters");
  const action = connect["@action"];
  if (action !== undefined) backendUrl(action, config, "http");
  const actionMethod = connect["@method"] ?? "POST";
  if (!["GET", "POST"].includes(actionMethod)) throw new MockError("INVALID_TWIML", "Invalid Connect method");
  return { url, language: stt.data, ttsLanguage: tts.data, greeting: String(relay["@welcomeGreeting"] ?? ""),
    interruptible: !["none", "false"].includes(relay["@interruptible"] ?? "any"), customParameters: parsedParameters.data,
    ...(action === undefined ? {} : { action }), actionMethod };
}

export async function mockRequest(url: string, method: "GET" | "POST", fields: Record<string, string>, config: Config, signal?: AbortSignal) {
  const target = backendUrl(url, config, "http");
  const headers: Record<string, string> = { "X-CallMate-Mock": "true" };
  const options: RequestInit = { method, redirect: "error", headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.BACKEND_TIMEOUT_MS)]) : AbortSignal.timeout(config.BACKEND_TIMEOUT_MS) };
  if (method === "POST") { headers["content-type"] = "application/x-www-form-urlencoded"; options.body = new URLSearchParams(fields); }
  else for (const [key, value] of Object.entries(fields)) target.searchParams.append(key, value);
  headers["X-Twilio-Signature"] = requestSignature(config.MOCK_AUTH_TOKEN, target.href, method === "POST" ? fields : {});
  const response = await fetch(target, options);
  // Always bound downloaded bodies, including successful callback responses.
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    try {
      let size = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.length;
        if (size > 16_384) throw new Error("Backend response exceeds limit");
        text += decoder.decode(item.value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  }
  return { status: response.status, ok: response.ok, text };
}

/** Deliberately small post-Connect interpreter. Unsupported TwiML must never look successful. */
export function parseContinuation(xml: string): { pauseSeconds: number } {
  if (Buffer.byteLength(xml) > 16_384 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new MockError("INVALID_TWIML", "Invalid Connect action response XML");
  }
  const document = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "@",
    parseAttributeValue: false, trimValues: true }).parse(xml) as Record<string, unknown>[];
  const roots = document.filter((node) => !Object.keys(node).some((key) => key.startsWith("?")));
  const nodes = roots[0]?.Response;
  if (roots.length !== 1 || !Array.isArray(nodes) || nodes.length > 20) throw new MockError("UNSUPPORTED_TWIML", "Expected a bounded Response continuation");
  let pauseSeconds = 0;
  for (const node of nodes) {
    const verb = Object.keys(node).find((key) => key !== ":@");
    const attributes = node[":@"] ?? {};
    if (verb === "Hangup" && !node.Hangup.length && !Object.keys(attributes).length) return { pauseSeconds };
    if (verb !== "Pause" || node.Pause.length || Object.keys(attributes).some((key) => key !== "@length")) {
      throw new MockError("UNSUPPORTED_TWIML", "Connect action response supports only Pause and Hangup");
    }
    const length = String(attributes["@length"] ?? "1");
    if (!/^[1-9]\d*$/.test(length) || Number(length) > 60) throw new MockError("INVALID_TWIML", "Pause length must be 1–60 seconds");
    pauseSeconds += Number(length);
  }
  return { pauseSeconds };
}
