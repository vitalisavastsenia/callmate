import { ReadinessSchema } from "@callmate/contracts";
import type { z } from "zod";
import type { Config } from "./config.js";
import { configurationValid } from "./config.js";
import type { Store } from "./storage.js";
import { MockCallsClient } from "./mock-calls-client.js";
import { mockRelayEnabled } from "./mock-relay.js";
import { codexLoginReady } from "./codex-ready.js";

type Check = z.infer<typeof ReadinessSchema>["checks"][number];
type Capability = z.infer<typeof ReadinessSchema>["capabilities"][number];

/** Read-only, private diagnostics. No calls, redial, hangup or transcript access. */
export class Readiness {
  private probing: Promise<boolean> | undefined;
  constructor(private config: Config, private store: Store, private dialogueEnabled = config.dialogueProvider !== "disabled") {}
  private mockAvailable() {
    // Share concurrent requests, but do not cache a completed result across later requests.
    return this.probing ??= new MockCallsClient(this.config).check().then(() => true, () => false)
      .finally(() => { this.probing = undefined; });
  }
  async report() {
    const checks: Check[] = [];
    let storage = false;
    try { this.store.check(); storage = true; } catch { /* Report only safe allowlisted messages. */ }
    let configuration = configurationValid(this.config);
    if (storage) {
      try { this.store.getSettings(); } catch { configuration = false; }
    }
    checks.push({ name: "storage", status: storage ? "ready" : "failed",
      message: storage ? "SQLite application tables are readable" : "SQLite application storage is unavailable" });
    checks.push({ name: "configuration", status: configuration && storage ? "ready" : "failed",
      message: configuration && storage ? "Server configuration and stored settings are valid"
        : "Server configuration or stored settings could not be validated" });
    const base = configuration && storage;
    const simulator = this.config.mode === "simulator";
    const mockEnabled = mockRelayEnabled(this.config);
    const mock = mockEnabled && base ? await this.mockAvailable() : false;
    checks.push({ name: "mock", status: !mockEnabled ? "not_required" : mock ? "ready" : "failed",
      message: !mockEnabled ? "Manual mock transport is disabled; no connectivity probe sent"
        : !base ? "Mock connectivity was not checked because local prerequisites failed"
        : mock ? "Local mock health endpoint responded with the expected service identity"
        : "Local mock health check failed or timed out" });
    checks.push({ name: "telephony", status: simulator ? "ready" : "missing",
      message: simulator ? (mockEnabled ? "Local mock telephony is enabled; real calling is disabled" : "Scripted fake telephony is installed; real calling is disabled") : "Live telephony is not implemented" });
    checks.push({ name: "voice", status: !simulator ? "missing" : !mockEnabled ? "not_required" : mock && base ? "ready" : "failed",
      message: !simulator ? "Live voice is not implemented" : !mockEnabled ? "Scripted text playback needs no voice provider"
        : "Local mock relay handler is enabled; callback and WebSocket round trips have not been probed" });
    const dialogueReady = this.dialogueEnabled && base && (this.config.dialogueProvider !== "codex" || await codexLoginReady());
    checks.push({ name: "dialogue", status: this.dialogueEnabled ? dialogueReady ? "ready" : "failed" : mockEnabled || !simulator ? "missing" : "ready",
      message: this.dialogueEnabled ? this.config.dialogueProvider === "codex"
        ? dialogueReady ? "Codex CLI and saved ChatGPT login are available; model connectivity has not been probed; mock booking acceptance uses simulated output receipts; real booking is unavailable"
          : "Codex CLI or saved ChatGPT login is unavailable; run the Docker login setup"
        : "OpenAI API dialogue is configured; credentials/connectivity have not been probed; mock booking acceptance uses simulated output receipts; real booking is unavailable"
        : mockEnabled ? "Reviewed mock calls require a configured dialogue engine; scripted fallback is disabled"
        : simulator ? "Scripted dialogue is installed; no model integration is enabled" : "Live dialogue is not implemented" });
    checks.push({ name: "tunnel", status: simulator ? "not_required" : "missing",
      message: simulator ? "Local development needs no public tunnel" : "Public tunnel connectivity has not been verified" });
    const capability = (name: Capability["name"], enabled: boolean, available = base): Capability => ({ name, enabled, ready: enabled && available });
    return ReadinessSchema.parse({ mode: this.config.mode, ready: base && simulator && (!mockEnabled || mock), voiceEngine: this.dialogueEnabled ? "conversation_relay" : null,
      checks, capabilities: [
        capability("scripted_calls", simulator && this.config.telephonyProvider === "fake" && !this.dialogueEnabled), capability("manual_mock_calls", mockEnabled, base && mock),
        capability("mock_relay", mockEnabled, base && mock), capability("mock_status_callbacks", mockEnabled, base && mock),
        capability("history", true), capability("approvals", simulator), capability("automatic_retention", true),
        capability("test_rate_budgets", simulator && this.config.testRateMinorPerMinute !== undefined),
        capability("live_calls", false), capability("dialogue_integration", this.dialogueEnabled, dialogueReady && mock), capability("provider_billing", false),
      ] });
  }
}
