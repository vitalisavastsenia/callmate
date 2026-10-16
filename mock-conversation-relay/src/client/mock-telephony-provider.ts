/** Explicit gate for a consuming backend's otherwise shared webhook/WS handlers. */
export function isDevelopmentMockTraffic(input: { environment: string; provider: string; mockHeader: string | undefined }) {
  return ["development", "test"].includes(input.environment) && input.provider === "mock" && input.mockHeader === "true";
}

/** Example consuming-backend adapter. No Twilio SDK or production DNS changes. */
export class MockTelephonyProvider {
  constructor(private options: { environment: "development" | "test"; provider: "mock"; baseUrl: string;
    accountSid: string; username: string; password: string }) {
    if (!["development", "test"].includes(options.environment) || options.provider !== "mock") throw new Error("Mock adapter is development-only");
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "host.docker.internal", "mock-relay"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Expected local mock API origin");
  }
  private async request(path: string, body?: URLSearchParams) {
    const response = await fetch(`${new URL(this.options.baseUrl).origin}/2010-04-01/Accounts/${encodeURIComponent(this.options.accountSid)}/Calls${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(5000), headers: {
        authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64")}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      }, ...(body ? { body } : {}),
    });
    if (!response.ok) throw new Error(`Mock Calls request returned HTTP ${response.status}`);
    return response.json() as Promise<{ sid: string; status: string }>;
  }
  createCall(input: { to: string; from: string; url?: string; twiml?: string; statusCallback?: string; timeout?: number }) {
    const body = new URLSearchParams({ To: input.to, From: input.from, Method: "POST" });
    if (input.url) body.set("Url", input.url);
    if (input.twiml) body.set("Twiml", input.twiml);
    if (input.timeout) body.set("Timeout", String(input.timeout));
    if (input.statusCallback) {
      body.set("StatusCallback", input.statusCallback);
      for (const event of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", event);
    }
    // Do not automatically retry an ambiguous call-creation response.
    return this.request(".json", body);
  }
  getCall(sid: string) { return this.request(`/${encodeURIComponent(sid)}.json`); }
  hangup(sid: string) { return this.request(`/${encodeURIComponent(sid)}.json`, new URLSearchParams({ Status: "completed" })); }
}
