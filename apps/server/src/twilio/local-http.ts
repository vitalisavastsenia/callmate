import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import twilio from "twilio";

// Synthetic local-test identity, never accepted by a real Twilio account.
export const mockAccountSid = `AC${"0".repeat(32)}`;
export const mockAuthToken = "callmate-local-mock-not-a-real-auth-token";
export const mockFrom = "+12025550100";
export const formType = "application/x-www-form-urlencoded";
export type Form = Record<string, string | string[]>;

export function requireLoopback(value: string, protocol = "http:") {
  const url = new URL(value);
  if (url.protocol !== protocol || url.hostname !== "127.0.0.1" || url.username || url.password || url.hash) {
    throw new Error("Mock traffic must use a numeric loopback URL");
  }
  return url;
}
export async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local listener");
  return `http://127.0.0.1:${address.port}`;
}
export async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}
export async function readForm(req: IncomingMessage): Promise<Form> {
  if (req.headers["content-type"]?.split(";")[0] !== formType) throw new Error("Expected form encoding");
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > 32_768) throw new Error("Form too large");
  }
  const form: Form = Object.create(null);
  for (const [key, value] of new URLSearchParams(body)) {
    const previous = form[key];
    form[key] = previous === undefined ? value : [...(Array.isArray(previous) ? previous : [previous]), value];
  }
  return form;
}
export function signed(url: string, fields: Form, token = mockAuthToken) {
  return twilio.getExpectedTwilioSignature(token, url, fields);
}
export function validSignature(req: IncomingMessage, url: string, fields: Form) {
  const signature = req.headers["x-twilio-signature"];
  return typeof signature === "string" && twilio.validateRequest(mockAuthToken, signature, url, fields);
}
export async function postSigned(url: string, fields: Record<string, string>) {
  requireLoopback(url);
  const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { "content-type": formType, "X-Twilio-Signature": signed(url, fields) },
    body: new URLSearchParams(fields) });
  if (!response.ok) throw new Error(`Local callback rejected: HTTP ${response.status}`);
  return response;
}

export { createServer };
