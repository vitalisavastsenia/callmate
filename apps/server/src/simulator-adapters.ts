import { randomUUID } from "node:crypto";
import { DialogueProposalSchema, OfferSchema, PlaybackPermitSchema } from "@callmate/contracts";
import type {
  AttemptContext, BookingPolicyPort, CallSnapshot, DialogueInput, DialoguePort, Offer,
  PlaybackPermit, PolicyDecision, ProviderCallStatus, SimulatorScenario, TelephonyPort, TextVoicePort,
} from "@callmate/contracts";

/** Wire-level development feedback only; never extracts offers or accepts a booking. */
export function scriptedRelayReply(text: string, language: string) {
  const prefixes: Record<string, string> = {
    "en-US": "Development echo — no appointment is booked: ",
    "es-ES": "Eco de desarrollo — no se reserva ninguna cita: ",
    "ru-RU": "Тестовое эхо — запись не оформляется: ",
    "pl-PL": "Echo testowe — żadna wizyta nie jest rezerwowana: ",
  };
  return (prefixes[language] ?? prefixes["en-US"]!) + text;
}

/** Deliberately has no SDK, network client, credentials, or real phone-number handling. */
export class FakeTelephony implements TelephonyPort {
  private calls = new Map<string, ProviderCallStatus>();
  async startCall(context: AttemptContext) {
    const providerCallId = `simulator:${context.attemptId}`;
    this.calls.set(providerCallId, { status: "found", callState: "dialing", providerCallId });
    return { status: "accepted" as const, providerCallId };
  }
  async requestHangup(providerCallId: string) {
    this.calls.delete(providerCallId);
    return { status: "acknowledged" as const };
  }
  async queryCall(providerCallId: string): Promise<ProviderCallStatus> {
    return this.calls.get(providerCallId) ?? { status: "unknown" };
  }
  setState(id: string, callState: CallSnapshot["callState"]) {
    if (["ended", "busy", "no_answer", "failed"].includes(callState)) {
      this.calls.delete(`simulator:${id}`);
      return;
    }
    this.calls.set(`simulator:${id}`, { status: "found", callState, providerCallId: `simulator:${id}` });
  }
}

export function scriptedOffer(input: DialogueInput, scenario: SimulatorScenario, version = 1): Offer {
  const request = input.plan.request;
  const ceiling = request.pricePolicy.maximum?.amountMinor ?? 3000;
  const alternative = ["approval_required", "changed_offer"].includes(scenario);
  return OfferSchema.parse({
    id: input.offer?.id ?? randomUUID(), version,
    service: request.service, bookingName: request.bookingName, appointment: request.availability[0]!.start,
    durationMinutes: null,
    price: { amountMinor: alternative ? Math.min(Number.MAX_SAFE_INTEGER, ceiling + 500 * version) : ceiling, currency: "EUR" },
    conditions: { deposit: "none", cancellationFee: "none", paidAddOn: "none" },
    evidenceMessageIds: [input.triggerMessageId],
  });
}

/** Scripted extraction, not a substitute for Engineer 3's natural-language implementation. */
export class FakeDialogue implements DialoguePort {
  constructor(private scenario: SimulatorScenario) {}
  async propose(input: DialogueInput, signal: AbortSignal) {
    if (this.scenario === "pending_reply") {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("Simulator reply cancelled"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    return DialogueProposalSchema.parse({ turnId: input.turnId, turnVersion: input.turnVersion,
      candidate: { action: "evaluate_offer", offer: input.offer }, translations: [] });
  }
}

/** Limited deterministic simulator policy. Never used for live calls. */
// This scripted policy requests booking approval only; dialogue consent uses a separate contract.
type SimulatorPolicyDecision = Exclude<PolicyDecision, { decision: "ask_user" }> | {
  decision: "ask_user"; reason: NonNullable<CallSnapshot["pendingApproval"]>["reason"];
};
export const simulatorPolicy = {
  evaluate({ snapshot, candidate, now, grant }): SimulatorPolicyDecision {
    const offer = snapshot.activeOffer;
    if (candidate.action !== "accept_offer" || !offer || candidate.offerId !== offer.id
      || candidate.offerVersion !== offer.version || snapshot.callState !== "connected") {
      return { decision: "deny", reason: "Offer or call is no longer current" };
    }
    const request = snapshot.plan.request;
    if (offer.service !== request.service || offer.bookingName !== request.bookingName
      || Object.values(offer.conditions).some((condition) => condition !== "none")
      || Date.parse(offer.appointment.instant) <= Date.parse(now)) {
      return { decision: "deny", reason: "Unsupported or expired offer" };
    }
    const inWindow = request.availability.some((window) =>
      window.start.timeZone === offer.appointment.timeZone
      && Date.parse(window.start.instant) <= Date.parse(offer.appointment.instant)
      && Date.parse(offer.appointment.instant) < Date.parse(window.end.instant));
    const reason = !inWindow ? "outside_availability"
      : !offer.price && !request.pricePolicy.allowUnknownPrice ? "unknown_price"
      : offer.price && request.pricePolicy.maximum && offer.price.amountMinor > request.pricePolicy.maximum.amountMinor
        ? "above_price_limit" : request.bookingAuthority === "ask_before_accepting" ? "user_confirmation_required" : null;
    const validGrant = grant && grant.attemptId === snapshot.id && grant.planId === snapshot.plan.id
      && grant.planVersion === snapshot.plan.version && grant.offerId === offer.id
      && grant.offerVersion === offer.version && Date.parse(now) < Date.parse(grant.expiresAt);
    if (reason && !validGrant) return { decision: "ask_user", reason };
    return { decision: "allow", approvedSpanishText:
      `De acuerdo, reserve la cita el ${offer.appointment.localDate} a las ${offer.appointment.localTime}, a nombre de ${offer.bookingName}.` };
  },
} satisfies BookingPolicyPort;

export class FakeVoice implements TextVoicePort {
  readonly engine = "conversation_relay" as const;
  constructor(private consumePermit: (permit: PlaybackPermit) => boolean) {}
  async sendAuthorizedText(input: PlaybackPermit) {
    const permit = PlaybackPermitSchema.parse(input);
    if (!this.consumePermit(permit)) throw new Error("Playback permit is no longer valid");
    // This acknowledges simulated playback only; no audio or external request is produced.
  }
  async cancelOutput(_outputId: string) {}
  async close() {}
}
