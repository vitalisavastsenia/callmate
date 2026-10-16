import type { CallSnapshot, StoredCallSnapshot } from "@callmate/contracts";
import { CommandError } from "./errors.js";

export function assertDeletableAgreement(call: StoredCallSnapshot): asserts call is CallSnapshot {
  if (!call.plan || !["ended", "busy", "no_answer", "failed"].includes(call.callState)
    || !(call.outcome.status === "confirmed" || (call.outcome.status === "completed" && call.outcome.findings.some(finding => finding.answered))))
    throw new CommandError(409, "DATA_NOT_DELETABLE", "Only a saved agreement from a finished call can be deleted");
}
