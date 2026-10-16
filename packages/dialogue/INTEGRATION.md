# Engineer 3 integration handoff

The server imports public exports from `@callmate/dialogue` and shared schemas
and types from `@callmate/contracts`. Contract version: 1. Dialogue runs in the
server process and adds no HTTP service or database. The Codex CLI adapter uses saved ChatGPT login in a local subprocess; the optional
OpenAI API adapter uses server-supplied API credentials and one HTTPS request per turn.
Root workspace and Docker registration are complete on the integration branch.
Server bootstrap/controller wiring remains with Engineer 2; see [integration status](README.md#integration-with-engineer-2).

## Constructors and dependencies

```ts
import type { BookingPolicyPort, DialoguePort } from "@callmate/contracts";
import {
  createDialogueServices, type ModelClient, type OfferIdentitySource,
} from "@callmate/dialogue";

// These are configured by server bootstrap, never supplied by a browser/model.
declare const model: ModelClient;
declare const lookupReservedIdentity: OfferIdentitySource;

const { dialogue, bookingPolicy }: {
  dialogue: DialoguePort;
  bookingPolicy: BookingPolicyPort;
} = createDialogueServices(model, {
  timeoutMs: 10_000,
  offerIdentitySource: lookupReservedIdentity,
});
```

`createDialogueServices` is an inert convenience constructor returning the two
shared ports. `createDialogue(model, options)` and `createBookingPolicy()` remain
available individually, as do the `Dialogue` and `BookingPolicy` classes. All
constructors are exercised through the public package import by package tests.
No fallback fake model, provider client, grant, or live call is created.

- `ModelClient.generate(input, signal)` returns unknown structured output and
  observes cancellation. The server supplies its real or scripted adapter. Provider
  credentials, model selection/instructions, transport timeout, and adapter resource
  shutdown stay with that adapter; no live SDK is bundled here.
- `createCodexModelClient({ executable?, model?, timeoutMs? })` uses `codex exec`
  with forced ChatGPT authentication and no API-key fallback. Its default deadline
  is 60 seconds; set the planner deadline explicitly to match. See the
  [local subscription example](README.md#codex-cli-with-chatgpt-login).
- `createOpenAIModelClient({ apiKey, model, timeoutMs?, maxOutputTokens? })` is the
  included native-fetch Responses API adapter. Supply it to the same constructors;
  keep API credentials server-side. See [configuration and the text-only example](README.md#openai--codex-api-adapter).
  It never grants booking authority or bypasses policy, controller checks, or permits.
- `timeoutMs` defaults to 10,000 and accepts integers 1–60,000. Cancellation,
  bounded deadlines, sanitized error codes, and late-response disposal are
  documented in the [dialogue API](README.md#dialogue-port).
- `OfferIdentitySource` is a synchronous pure lookup of controller-reserved
  identities. It receives isolated attempt/turn/current-offer context and proposed
  facts without model-supplied identity. Reserve identities in the controller;
  persist only after rechecking the current attempt/turn. New/changed offers fail
  closed if the lookup is absent. Model output cannot supply backend authority.
- The controller supplies the current snapshot, server time, and an authenticated,
  resolved exact-offer grant or `null` to policy on every evaluation. There is no
  private authority store inside the module.

## Controller sequence

1. Validate/serialize the final business utterance and build `DialogueInput` with
   the latest finalized business trigger and current plan/offer/turn versions.
   Keep one `AbortController` per pending turn.
2. Call `dialogue.propose(input, signal)`. On return, recheck attempt, current
   turn/version, plan/offer versions, Stop, and intervening speech against current
   server state. The library cannot discover a newer controller revision on its own.
3. Persist translations by their existing message IDs. A proposal never writes
   messages, grants, booking state, or provider commands itself.
4. For a new/changed offer, persist the immutable offer and invalidate old
   approvals/permits. `reduceBooking(..., { type: "offer_received", offer }, now)`
   returns booking fields for the controller's atomic update. During a possible
   acceptance, preserve uncertainty instead of starting another booking.
5. Evaluate the candidate against the **current** snapshot, server time, and
   server-resolved grant. `allow` contains controlled Spanish text; `ask_user`,
   `clarify`, and `deny` contain no playback permission. The controller chooses a
   safe follow-up and issues/cancels its own permit even for neutral/waiting speech.
6. For `ask_user`, persist the exact offer/plan approval and wait. Authenticate
   decisions and check expiry/revocation before resolving the pending request.
   Grants are controller-owned. Clear pending approval before grant-based readback.
7. Play a controlled readback under a valid permit; record actual finalized playback.
   Then recheck policy before acceptance. Generated or interrupted text is not proof
   of playback. Cancellation/changed offers invalidate permits at the voice boundary.
8. After authorized acceptance was completely played, supply the controller-owned
   `AcceptancePlayback` receipt to the booking reducer. Only then await business
   confirmation. `record_business_confirmation` permits a neutral acknowledgement;
   it never establishes a confirmed outcome by itself.
9. Derive the outcome using the exact receipt and a `ConfirmationVerifier` assessing
   the actual Spanish evidence and all later corrections. Missing/unverified or
   ambiguous evidence produces uncertainty. There is no production semantic
   verifier in this package yet. Persist/emit the derived English result separately.

`reduceBooking` and `deriveOutcome` are pure controller helpers. The controller
increments revisions/events, enforces call limits, handles transactions and
database recovery, authenticates grants, and correlates provider callbacks.
`BookingTransitionError` means an invalid transition; it is not permission to
invent an alternate success state. Terminal results remain stable on late events.

For the supported hydration supplement, request user consent through
`reduceConversation` only after the base appointment is confirmed. Consent returns
only a non-committing review reply. Once approved, call
`prepareAddOnAcceptance` with the decision ID and a controller-reserved offer
identity. Persist the amended terms, authorize their exact text under a permit
bound to the amended offer, and retain actual playback evidence separately.
`reconcileAddOn` requires that receipt plus synchronous semantic verification of
the supplement and total before atomically updating the active offer and English
confirmed result. Persist its returned `conversation` atomically with the booking
fields: reconciliation invalidates any pending consent, including later contact
requests. Missing/contradictory evidence produces uncertainty. If amendment
speech may have started, use this reconciliation path on Stop/failure as well,
with empty evidence when needed; the original base result alone is insufficient.
See the [add-on lifecycle](README.md#optional-add-on-reconciliation).

When only contact/add-on consent is pending, `reduceBooking` handles Stop/failure
and offer changes by returning updated `conversation` alongside the booking
fields. Persist those fields together before publishing terminal call state.
Stopping after the base appointment was confirmed clears pending consent while
preserving that confirmed result. These helpers add no shared fields or protocol
version changes; their preparation/playback metadata stays controller-owned.

## Failure and teardown

On Stop, interruption, superseding turn, changed plan/offer, or server shutdown:
abort pending turn controllers, invalidate queued playback permits, and have the
voice adapter stop obsolete output. Dialing/hangup and provider reconciliation are
server responsibilities; aborting a dialogue promise does not hang up a call.

`DialogueError` exposes fixed `code`/message values without provider details or
transcript/abort reason text. There are no automatic retries. On malformed output,
timeout, or provider failure, the controller can clarify or end unresolved using
its bounded recovery policy. If acceptance might have started, retain uncertainty
and reconcile instead of reporting not booked or redialing automatically.

The dialogue/policy objects have no persistent resources or `close()` method.
After aborting pending turns, the server closes resources owned by its injected
model/voice/telephony adapters. Imports and construction perform no I/O.

## Reproduction and remaining integration

```sh
docker compose --profile checks run --build --rm checks
docker compose --profile checks run --build --rm checks npm run evaluate --workspace @callmate/dialogue
```

The [evaluation guide](evaluation/README.md) maps all 32 Spanish scenarios to
expected behavior and explains the scripted-model limits. The evaluation command
returns one test result per scenario, fails on any regression, and reports local
port timing separately from live audio latency. It does not require a telephone
call. The ordinary package test includes the evaluation suite, so CI can use one
command after building contracts. Root scripts include these checks.

The exported contract version is unchanged. Before an integrated app is
declared ready, Engineer 2 must wire the controller/providers, and
Engineers 2 and 3 must arrange a production Spanish semantic verifier and fluent
review. The standalone evaluations do not satisfy the combined-app or real-call
acceptance gates in the [engineering agreement](../../docs/engineering-contract.md).
