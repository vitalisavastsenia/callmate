import type { z } from "zod";
import type { StoredCallSnapshot, UsageSchema } from "@callmate/contracts";
import { CommandError } from "./errors.js";

type Usage = z.infer<typeof UsageSchema>;
type Emit = (type: "usage.updated", payload: Usage) => void;
export const terminalUsage = (call: StoredCallSnapshot) => ["ended", "busy", "no_answer", "failed"].includes(call.callState);

/** Explicit synthetic rates only. No provider price, rounding policy or billing API is inferred. */
export function initialUsage(now: string, rate: number | undefined, budget: { amountMinor: number; currency: "USD" }): Usage {
  if (rate === undefined) return { estimate: null, settledTotal: null, status: "unavailable", measuredAt: now };
  if (budget.amountMinor === 0) throw new CommandError(409, "BUDGET_EXCEEDED", "The test-rate call budget allows no elapsed time");
  return { estimate: { amountMinor: 0, currency: "USD" }, settledTotal: null, status: "estimated", measuredAt: now,
    testUsage: { source: "test_rates", rateVersion: "elapsed-minute-v1", rateMinorPerMinute: rate, currency: "USD",
      rateCapturedAt: now, elapsedMs: 0, budget: { ...budget } } };
}
function elapsed(call: StoredCallSnapshot, now: number) {
  return Math.max(call.usage.testUsage?.elapsedMs ?? 0, Math.max(0, now - Date.parse(call.createdAt)));
}
export function budgetExpired(call: StoredCallSnapshot, now: number): boolean {
  const meter = call.usage.testUsage;
  // BigInt keeps large allowed budgets exact, including values above the safe multiplication range.
  return !!meter && BigInt(elapsed(call, now)) * BigInt(meter.rateMinorPerMinute) >= BigInt(meter.budget.amountMinor) * 60000n;
}
export function usageSampleDue(call: StoredCallSnapshot, now: number) {
  return !!call.usage.testUsage && !terminalUsage(call)
    && Math.floor(elapsed(call, now) / 1000) > Math.floor(call.usage.testUsage.elapsedMs / 1000);
}
export function measureUsage(call: StoredCallSnapshot, now: number, emit: Emit) {
  const meter = call.usage.testUsage;
  if (!meter) return;
  const elapsedMs = elapsed(call, now);
  if (elapsedMs === meter.elapsedMs) return;
  const amount = (BigInt(elapsedMs) * BigInt(meter.rateMinorPerMinute) + 59999n) / 60000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Test usage exceeds supported range");
  call.usage = { estimate: { amountMinor: Number(amount), currency: "USD" }, settledTotal: null, status: "estimated",
    measuredAt: new Date(Math.max(now, Date.parse(call.usage.measuredAt))).toISOString(), testUsage: { ...meter, elapsedMs } };
  emit("usage.updated", call.usage);
}
