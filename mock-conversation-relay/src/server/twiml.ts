import { XMLParser, XMLValidator } from "fast-xml-parser";
import { backendUrl, language, MockError } from "./config.js";
import type { Config } from "./config.js";
import { parameters } from "../protocol/schemas.js";

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
