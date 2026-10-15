import { ReadinessSchema } from "@callmate/contracts";
import type { z } from "zod";
import type { Config } from "./config.js";
import { configurationValid } from "./config.js";
import type { Store } from "./storage.js";
import { MockCallsClient } from "./mock-calls-client.js";
import { mockRelayEnabled } from "./mock-relay.js";

type Check = z.infer<typeof ReadinessSchema>["checks"][number];
type Capability = z.infer<typeof ReadinessSchema>["capabilities"][number];

/** Read-only, private diagnostics. No calls, redial, hangup or transcript access. */
export class Readiness {
  private probing: Promise<boolean> | undefined;
  constructor(private config: Config, private store: Store) {}
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
      message: simulator ? "Scripted fake telephony is installed; real calling is disabled" : "Live telephony is not implemented" });
    checks.push({ name: "voice", status: !simulator ? "missing" : !mockEnabled ? "not_required" : mock && base ? "ready" : "failed",
      message: !simulator ? "Live voice is not implemented" : !mockEnabled ? "Scripted text playback needs no voice provider"
        : "Local mock relay handler is enabled; callback and WebSocket round trips have not been probed" });
    checks.push({ name: "dialogue", status: simulator ? "ready" : "missing",
      message: simulator ? "Scripted dialogue is installed; no model integration is enabled" : "Live dialogue is not implemented" });
    checks.push({ name: "tunnel", status: simulator ? "not_required" : "missing",
      message: simulator ? "Local development needs no public tunnel" : "Public tunnel connectivity has not been verified" });
    const capability = (name: Capability["name"], enabled: boolean, available = base): Capability => ({ name, enabled, ready: enabled && available });
    return ReadinessSchema.parse({ mode: this.config.mode, ready: base && simulator && (!mockEnabled || mock), voiceEngine: null,
      checks, capabilities: [
        capability("scripted_calls", simulator), capability("manual_mock_calls", mockEnabled, base && mock),
        capability("mock_relay", mockEnabled, base && mock), capability("mock_status_callbacks", mockEnabled, base && mock),
        capability("history", true), capability("approvals", simulator), capability("automatic_retention", true),
        capability("test_rate_budgets", simulator && this.config.testRateMinorPerMinute !== undefined),
        capability("live_calls", false), capability("dialogue_integration", false), capability("provider_billing", false),
      ] });
  }
}
