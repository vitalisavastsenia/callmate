import { createHmac } from "node:crypto";

/** Twilio's URL + sorted form fields HMAC-SHA1 scheme, using a synthetic local token. */
export function requestSignature(token: string, url: string, fields: Record<string, string> = {}) {
  const payload = Object.keys(fields).sort().reduce((value, key) => value + key + fields[key], url);
  return createHmac("sha1", token).update(payload, "utf8").digest("base64");
}
