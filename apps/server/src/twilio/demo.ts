import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { approvedPlanFixture } from "@callmate/contracts/fixtures";
import { MockTwilioAdapter } from "./mock-adapter.js";
import { TwilioMock } from "./mock.js";

const mock = await new TwilioMock().start();
// Only this synthetic walkthrough grants output; this is not a booking-policy implementation.
const adapter = await new MockTwilioAdapter(mock.baseUrl, () => true).start();
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  throw new Error("Timed out waiting for the local demo");
}
try {
  const attemptId = randomUUID();
  const plan = structuredClone(approvedPlanFixture);
  const call = await adapter.startCall({ attemptId, plan });
  if (call.status !== "accepted") throw new Error("Local mock rejected call creation");
  const id = call.providerCallId;
  await mock.progress(id, "initiated");
  await mock.progress(id, "ringing");
  await mock.progress(id, "in-progress");
  await mock.connectRelay(id);
  await until(() => adapter.observations.some((event) => event.type === "relay.message" && event.message.type === "setup"));
  mock.send(id, { type: "prompt", voicePrompt: "Peluquería, ¿en qué puedo ayudarle?", lang: "es-ES", last: true });
  await until(() => adapter.observations.some((event) => event.type === "business.utterance"));
  await adapter.sendAuthorizedText({ id: randomUUID(), attemptId, planId: plan.id, planVersion: plan.version,
    turnId: randomUUID(), turnVersion: 1, outputId: randomUUID(), offer: null,
    approvedSpanishText: "Hola, quisiera pedir una cita para cortarme el pelo.", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await until(() => mock.calls.get(id)!.received.length === 1);
  await adapter.endSession(attemptId, JSON.stringify({ reason: "offline-protocol-demo-complete" }));
  await until(() => mock.calls.get(id)!.status === "completed");
  console.log(JSON.stringify({ mode: "offline-twilio-protocol-demo", providerCallId: id,
    callStates: adapter.observations.filter((event) => event.type === "call.status").map((event) => event.callState),
    relayReceived: mock.calls.get(id)!.received.map((message) => message.type),
    finalQuery: await adapter.queryCall(id), realPhoneCall: false, bookingConfirmed: false }, null, 2));
  if (mock.failures.length) throw new Error("Mock protocol failures occurred");
} finally { await adapter.close(); await mock.close(); }
