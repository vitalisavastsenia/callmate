# @callmate/dialogue

Engineer 3's in-process dialogue and booking library for CallMate. The package
implements `DialoguePort`, `BookingPolicyPort`, controlled Spanish replies, pure
booking transitions, evidence checks, and English outcome derivation. It provides a raw
`ModelClient` interface and offline test support using `@callmate/contracts`.
The model adapter is injected. `createCodexModelClient` uses saved ChatGPT login
through Codex CLI; `createOpenAIModelClient` is the optional, separately billed
OpenAI Responses API adapter using native `fetch`.

See the [server integration handoff](INTEGRATION.md) for constructors, controller
sequencing, authority/playback boundaries, cancellation, and shutdown. The
[evaluation guide](evaluation/README.md) lists 32 named Spanish regression scenarios.

Use Node.js 24 or newer. Compiler settings and the TypeScript version match the
contracts package. There is currently no shared base TypeScript configuration.

## Integration with Engineer 2

The server’s `verifyMockConfirmation` matcher recognizes bounded confirmations in all four supported languages, including “Да подтверждаю” / “Да я уже подтвердил это”, “Sí, confirmo” / “Sí, ya lo he confirmado”, “Yes, I confirm” / “Yes, I already confirmed that”, and “Tak, potwierdzam” / “Tak, już to potwierdziłem”. Negation, uncertainty, and changed terms still require clarification. The caller must separately validate booking state, completed acceptance playback, and evidence ordering before recording a confirmed booking; this matcher does not provide unrestricted semantic verification of arbitrary speech.

The integration branch now includes an optional mock-call controller using this library. See [runtime setup and limits](../../docs/docker-development.md#17-dialogue-driven-local-mock-calls). It processes finalized Spanish replies and sends policy-approved text; acceptance and confirmation still require the missing playback/verifier integration.

The integration branch registers `packages/dialogue` alongside contracts, backend,
and web. Root build/typecheck/test scripts include it, with contracts built first.
Docker includes the library, tests, and shared dialogue fixtures. The mock controller invokes the library when enabled; real provider playback and confirmation remain integration tasks under [the engineering agreement](../../docs/engineering-contract.md).

The shared request keeps the UI's list of tone preferences. Legacy dialogue
values `formal`, `very_polite`, and `friendly` normalize to that list when parsed.
Controlled Spanish replies use friendly tú only when Friendly is selected without
an explicit Formal/Very polite preference; otherwise they retain formal usted.
This affects phrasing, never booking authority.

## Build and typecheck

Run the combined offline checks from the repository root in Docker:

```sh
docker compose --profile checks run --build --rm checks
```

Build output goes into ignored `dist/` directories. The root test command includes
contracts, dialogue tests and evaluations, backend tests, and web unit tests.
Checks use injected fake adapters and make no provider requests or telephone calls.

To run only dialogue type checking or the named Spanish scenario evaluation:

```sh
docker compose --profile checks run --build --rm checks npm run typecheck --workspace @callmate/dialogue
docker compose --profile checks run --build --rm checks npm run evaluate --workspace @callmate/dialogue
```

It covers prohibited commitments, exact-offer grants, changed offers, rejected
and expired approvals, interrupted speech, Stop, timeouts, and uncertain outcomes.
Each scenario reports its result and measured local port execution time with a
scripted model. This does not measure live telephone or provider latency.

## Fixtures, builders, and fake model

Five synthetic conversations in [the fixture directory](../../tests/dialogue-fixtures/README.md)
cover an allowed booking, no availability, business refusal, missing price, and
an ambiguous time. These are initial dialogue-local IDs, not additions to the
backend's shared scenario registry. Coordinate their mapping with Engineer 2.

Test support lives under `test/support/` and is not part of the production export:

- `builders.mjs`: fresh plans, messages, offers, simulator snapshots, dialogue
  inputs, and proposals parsed with the shared runtime schemas. Overrides are
  shallow; supply complete nested objects. Additional assertions check evidence,
  current-offer references, and translation/turn bindings.
- `conversations.mjs`: reads the fixture files, validates expected proposals and
  outcomes, and constructs per-turn snapshots without exposing future messages.
- `fake-model.mjs`: implements the `ModelClient.generate(input, signal)` shape,
  records isolated request copies, and consumes a finite script. Responses remain
  `unknown`, including intentionally malformed output for future planner tests.

Example from a package test:

```js
import { buildDialogueInput } from "./support/builders.mjs";
import { FakeModel } from "./support/fake-model.mjs";

const model = new FakeModel([{ kind: "pending", value: "malformed model output" }]);
const controller = new AbortController();
const reply = model.generate(buildDialogueInput(), controller.signal);
model.releaseNext(); // No timer or provider call; releases the oldest pending reply.
const raw = await reply;
```

Script steps are `response` (immediate raw value), `error` (throw the supplied
`Error`), or `pending` (wait for `releaseNext()` or cancellation). A pre-aborted
request consumes no step. Aborting a pending request removes it, so later release
cannot return the obsolete reply. Script exhaustion is an error, with no fallback
or retry. Release or abort each pending request in tests; the fake owns no timers
or external resources.

The tests validate fixture consistency, fake-model behavior, pure booking logic,
deterministic policy decisions, and the dialogue port's validation, timeout,
cancellation, and English translation bindings. They do not prove Spanish interpretation
quality. The 32-scenario evaluation uses authored model responses; live-model
evaluation and fluent-speaker review remain required.

## Codex CLI with ChatGPT login

Use this path for local development with the Codex usage included in your ChatGPT
plan. API credits are separate and are not needed here. Subscription limits still
apply; the adapter never falls back to API-key billing. See the official
[authentication guide](https://learn.chatgpt.com/docs/auth) and
[non-interactive mode guide](https://learn.chatgpt.com/docs/non-interactive-mode).

Install a current Codex CLI supporting `exec --output-schema`, `--ephemeral`,
`--ignore-user-config`, and `--ignore-rules` (verified with 0.160.0). Run
`codex login`, choose ChatGPT, and verify `codex login status` reports ChatGPT.
After building contracts and dialogue as above, run from the repository root:

```sh
node packages/dialogue/examples/codex-turn.mjs < packages/dialogue/examples/ambiguous-time.json
```

No `.env` or API key is required. Optional `CODEX_PATH` selects the trusted CLI
executable; `CODEX_MODEL` overrides the CLI's built-in default model. User config
is ignored, so its model and custom providers are not inherited. Do not supply
these options from a browser or conversation. This command only prints a validated
proposal and English translations: it never calls a telephone or books anything.

```ts
import { createCodexModelClient, createDialogue } from "@callmate/dialogue";

const model = createCodexModelClient({ timeoutMs: 60_000 });
const dialogue = createDialogue(model, {
  timeoutMs: 60_000,
  offerIdentitySource: lookupReservedOfferIdentity,
});
const proposal = await dialogue.propose(input, turnAbortController.signal);
// Recheck controller state and booking policy before playback.
```

Each turn launches `codex exec` without a shell in a private temporary directory,
using the proposal JSON schema and fixed dialogue instructions. ChatGPT login is
forced; API keys and provider environment overrides are removed from the child.
User configuration and rules are ignored; shell, apps, plugins, hooks, browser,
image, memory and agent features are disabled, with read-only sandboxing and no
approval prompts. Plan/transcript input goes to stdin and to OpenAI through Codex.
The final answer is limited to 256 KiB, parsed and checked with the shared schema,
then validated against current dialogue context by the planner. Temporary schema,
instructions and answer files are deleted, and `--ephemeral` avoids saved sessions.
Codex may maintain its own operational logs in its user directory; this is not a
promise of zero provider or CLI retention.

Construction performs no I/O. Stop terminates the in-flight process group on
macOS/Linux (or the direct process on Windows), escalating to forced termination
if needed, and discards late output. There are no application retries.
`CodexModelError.code` is one of `cli_unavailable`, `cli_failed`,
`invalid_response`, `cancelled`, or `timeout`; raw child diagnostics are discarded.
Through the planner, adapter failures become `model_failed`, while planner
cancellation/deadline stay `cancelled`/`timeout`. For `cli_failed`, check CLI
version, `codex login status`, subscription limits and network access.

The CLI adapter and example default to 60 seconds. The planner's general default
remains 10 seconds, so configure it explicitly for this adapter. CLI startup/model
latency can be too slow for a live telephone conversation; this path is suitable
for local text testing, not a verified real-time voice integration. Offline tests
use executable subprocess doubles and require no login or network.

## OpenAI / Codex API adapter

Configure an explicit model ID available to your OpenAI API account, with support
for Responses and Structured Outputs. There is no implicit model selection or
fallback to a different model. This uses an API key, not the Codex CLI login.
See the official [model catalog](https://developers.openai.com/api/docs/models)
and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).

```ts
import { createOpenAIModelClient, createDialogueServices } from "@callmate/dialogue";

// Read only in server bootstrap. Never accept these settings from the browser.
const model = createOpenAIModelClient({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
  timeoutMs: 10_000,
  maxOutputTokens: 4096,
});
const { dialogue, bookingPolicy } = createDialogueServices(model, {
  offerIdentitySource: lookupReservedOfferIdentity, // Controller-owned pure lookup.
});
const proposal = await dialogue.propose(input, turnAbortController.signal);
// Recheck current state, then evaluate bookingPolicy before any playback.
```

The adapter sends one non-streaming POST to `https://api.openai.com/v1/responses`
with `store: false`, fixed planner instructions, the validated context as user
data, and a strict JSON schema derived from `DialogueProposalSchema`. Business
speech cannot become system instructions. It sends the plan and transcript to
OpenAI; the key is only in the HTTP authorization header. There are no automatic
retries, tool executions, persistent provider sessions, or construction-time calls.
The schema uses `anyOf` for discriminated actions; string lengths, evidence,
turn/version bindings, and timezone refinements are still checked locally.

Only a completed assistant final answer containing a valid proposal is usable.
Codex commentary and reasoning items are excluded from the answer. Refusals,
incomplete output, tool calls, malformed JSON, HTTP failures, and network failures
fail the turn. `OpenAIModelError` exposes a fixed `code`, optional HTTP `status`,
and an allowlisted `providerCode`
without provider bodies, transcripts, credentials, or abort reasons. Through
`DialoguePort`, adapter failures become `DialogueError("model_failed")`; the
planner's own cancellation and deadline remain `cancelled` and `timeout`.
The adapter defaults to a 10-second deadline and 4096 output tokens. Configure its
deadline at least as long as the planner's deadline to retain planner timeout codes.
Output-token limits include model reasoning; increase the limit explicitly if
needed. Stop aborts the in-flight HTTP request, including response-body reading.

To try one text-only turn after building contracts and dialogue:

1. Copy the root `.env.example` to `.env` and fill in your API key and model ID.
2. From the repository root, run:

```sh
node --env-file=.env packages/dialogue/examples/openai-turn.mjs < packages/dialogue/examples/ambiguous-time.json
```

This command makes a real API request using synthetic input and prints a validated
proposal. It does not play speech, apply a booking decision, or call a telephone.
The example reserves an in-memory offer identity for this one invocation; the
application controller must implement durable reservation/invalidation separately.
The example also accepts any valid `DialogueInput` JSON on stdin. Ordinary tests
use an injected mock HTTP transport and require no key or network connection.

If the command fails, it prints the planner error plus the sanitized adapter code
and HTTP status, for example `OpenAI: http_error (HTTP 401)`. It does not print
the key, transcript, raw API error body, or provider exception. For HTTP 401, check
that `OPENAI_API_KEY` is an active OpenAI API key. An exported shell variable takes
precedence over Node's `--env-file` values; after editing `.env`, use
`unset OPENAI_API_KEY` if an old value is exported. The same precedence applies to
`OPENAI_MODEL`. HTTP 404 points to model availability/access. For HTTP 429, the
command also prints a recognized API code: `insufficient_quota` requires checking
API credits and billing/usage limits; `credit_balance_exhausted` requires adding
API credits; spend/usage-limit codes identify the corresponding limit. Repeated
requests do not resolve these conditions. `rate_limit_exceeded` or `slow_down`
instead require pacing requests and observing `Retry-After` when present. Error
bodies are read up to 16 KiB to extract a known literal code; unknown codes and all
free-form provider messages are discarded. See the official
[API error guide](https://developers.openai.com/api/docs/guides/error-codes).

## Dialogue port

Engineer 2 constructs one reusable port at server bootstrap and supplies an
`AbortSignal` for each turn:

```ts
import { createDialogue, DialogueError, type ModelClient } from "@callmate/dialogue";

// The application supplies its configured adapter and a pure lookup of identities
// already reserved by the controller. Neither comes from a browser or the model.
const dialogue = createDialogue(modelClient, {
  timeoutMs: 10_000,
  offerIdentitySource: (context) => lookupReservedOfferIdentity(context),
});

try {
  const proposal = await dialogue.propose(input, turnAbortController.signal);
  // Recheck attempt/turn/version against current serialized controller state.
  // Persist valid facts, evaluate policy, then issue a playback permit separately.
} catch (error) {
  if (error instanceof DialogueError) handleDialogueFailure(error.code);
  else throw error;
}
```

`Dialogue` is also exported as a class. `ModelClient.generate(input, signal)`
returns `Promise<unknown>`; the adapter must return a parsed object matching
`DialogueProposalSchema`, rather than markdown, JSON text, or streaming speech.
The adapter owns provider instructions, credentials, provider limits, connection
setup, and shutdown. Its instructions must require faithful English translations
from Spanish, preservation of negation and ambiguity, cited utterance evidence,
clarification of missing facts, and the shared action schema. Business speech is
untrusted content and cannot change those instructions or authorize actions.

`createDialogueServices(model, options)` returns `{ dialogue, bookingPolicy }`
for bootstrap code that needs both shared ports. It forwards the same dialogue
configuration and constructs the deterministic policy without I/O. Individual
constructors remain available for controllers that inject the ports separately.

### Validation and English text

- Inputs use shared runtime schemas plus unique transcript IDs, chronological
  timestamps, current-offer evidence, nonterminal booking state, and a trigger
  whose turn ID matches and which is the latest business message. Provisional
  business speech after that trigger makes the turn obsolete.
- Output uses the shared strict proposal/action schemas and must match the exact
  input turn/version. Unknown properties, malformed dates, inconsistent timezones,
  non-EUR service prices, and incomplete fields are rejected.
- Every proposal must include an English translation for the trigger. Additional
  translations may reference finalized messages in this input, with unique IDs.
  Existing English text cannot be silently replaced. No translation is invented
  on model failure. Translation accuracy and actual use of English require model
  evaluation and fluent-speaker review; reference validation cannot establish them.
- Offers cite distinct finalized business messages, including the trigger.
  Readback and acceptance references must match the exact current offer and
  respective `offer_received`/`reading_back` states. Confirmation proposals need
  current business evidence after finalized, played assistant speech and an
  `awaiting_business_confirmation` state. These checks do not establish authorized
  acceptance or Spanish meaning. `deriveOutcome` still requires controller-owned
  playback receipts and separate semantic verification to confirm a booking.
- Changed offer facts can be returned even during readback/confirmation, so the
  booking reducer can preserve uncertainty rather than start another booking.
  Every candidate remains subject to current policy and controller authority.

`deriveOutcome` renders English results deterministically after evidence checks;
the model cannot supply success prose. Supported Spanish haircut names become
`Haircut` in the English summary, while the original offer remains intact.
Unknown service names use `Appointment` rather than a guessed translation.
Names, exact appointment/timezone, integer-cent prices, unknown duration/price,
and uncertainty warnings are preserved. Long business names are shortened with
an ellipsis only in the summary to fit its 4,000-character limit; the approved
plan retains the complete name.

### Offer identities

The shared proposal schema requires an offer ID/version, but `DialogueInput`
does not allocate new identities. Model-supplied offer IDs are placeholders.
The synchronous, pure `OfferIdentitySource` receives isolated attempt/turn/version,
current-offer context, and proposed facts **without** model-selected ID/version.
It returns a controller-reserved `{ offerId, offerVersion }`. The dialogue port
replaces the placeholder; changed facts cannot reuse the current ID at an equal
or older version. Identical facts and evidence reuse the current backend identity
without consulting the lookup. Evidence-only changes require a new identity/version.

The lookup must not write records or grant authority. Engineer 2 reserves identities
in the controller and persists accepted proposals atomically with current version
checks. An async/throwing/malformed lookup fails closed. Without a lookup, existing
offers and clarification work, but new/changed offers fail with
`offer_identity_required`. Never pass model identities through as server authority.

### Cancellation, deadlines, and failures

The timeout defaults to 10 seconds; `timeoutMs` must be an integer from 1 through
60,000. A child signal is aborted on timeout or caller cancellation. The promise
rejects promptly even when the provider ignores abort; late resolutions and
rejections cannot produce proposals or invoke the identity lookup. Timers and
parent-signal listeners are removed on success, failure, cancellation, and timeout.
Concurrent attempts are isolated. Synchronous code cannot be preempted, so model
adapters and identity lookups must not block the event loop; deadline checks also
discard results that finish after the budget.

`DialogueError.code` is one of `invalid_input`, `invalid_model_output`,
`model_failed`, `cancelled`, `timeout`, `offer_identity_required`, or
`invalid_offer_identity`. Errors contain fixed messages without provider details,
transcript text, or caller abort reasons. There are no automatic retries or
acceptance fallbacks. The controller decides whether to clarify, end unresolved,
or reconcile a possible acceptance; a dialogue failure alone never proves that
no booking exists.

On Stop, interruption, changed plan/offer, or superseding turn, abort obsolete
work and invalidate controller-owned permits. The port is stateless and cannot
observe newer server revisions automatically. The controller must always reject
stale results and recheck current state before speech, including after a successful
promise has settled.

## Booking policy and Spanish replies

The server constructs the shared port without configuration or provider access:

```ts
import { createBookingPolicy } from "@callmate/dialogue";

const policy = createBookingPolicy(); // BookingPolicyPort
const decision = policy.evaluate({
  snapshot, candidate, now: serverNow, grant: serverResolvedGrantOrNull,
});
```

`BookingPolicy` is also exported as a class. `evaluate` is synchronous and does
not mutate inputs or create grants, permits, database records, or speech. It
parses snapshots, candidates, and server time with the shared schemas. Invalid
input, stopped/non-connected calls, terminal bookings, and future authority
timestamps cannot authorize output. Call cost and duration enforcement remain
controller responsibilities; the haircut price limit is independent of USD call costs.

### Constraints and exact-offer grants

- The initial service vocabulary is `Haircut`, `corte de pelo`, and `corte de
  cabello`, matched without case/spacing differences. Unknown requested services
  require clarification; a different offered service cannot be approved by a grant.
- Booking names must match the reviewed plan after Unicode, case, and whitespace
  normalization. The response uses the plan's name, never arbitrary model prose.
  Name changes require clarification. No phone or email is included in responses,
  even when sharing one would be permitted; there is no contact-sharing candidate
  in the current contracts.
- Appointment instants must be in the future and retain the reviewed business
  timezone. Availability starts are inclusive and ends exclusive. A known duration
  must fit completely within one window. An unknown duration stays unknown.
- Service prices use integer EUR cents. Unknown price is distinct from zero.
  Outside availability, price above the limit, disallowed unknown price, and
  `ask_before_accepting` authority produce `ask_user` unless a valid exact-offer
  grant covers the offer. This order determines the primary reason when several
  exceptions apply; approval must show the complete offer.
- Required deposits, cancellation fees, or paid add-ons always produce `deny`,
  including with a grant. Unknown conditions require clarification. The planner
  must correctly extract payment requirements into the supported conditions;
  policy does not infer the truth of facts from Spanish text.

Grant types come from the shared `BookingPolicyPort`; no competing schema or
authority store is introduced. Supplied grants must have exactly the documented
fields, valid IDs/versions/time, matching attempt/plan/current immutable offer,
and `now < expiresAt`. Changed, malformed, or expired grants never fall back to
broader automatic authority. A grant can cover multiple allowed exceptions for
that exact offer; it cannot override hard constraints.

The controller must resolve authenticity, rejection, revocation, consumption,
and cancellation against its authoritative records **before** supplying a grant.
The policy cannot discover those facts from IDs and expiry alone. A pending
approval remains blocking even with a matching grant-shaped value: first record
its resolution and clear the pending state. Persist a new offer/version and
invalidate older authority before asking for grant-based readback of that offer.

### Controlled output sequence

1. `evaluate_offer` checks facts/authority but can return only a neutral reply,
   never spoken acceptance.
2. `read_back` renders the exact date, local time, timezone/UTC offset, approved
   service/name, price, and excluded conditions. It explicitly says the proposal
   has not yet been accepted. The controller records actual playback.
3. `accept_offer` requires `reading_back` state and the latest exact matching
   controlled readback after the offer evidence to be finalized and fully played,
   including any replay. It rechecks the
   current plan and grant. Interrupted or unrelated text cannot substitute for
   readback; `clarify` with `field: "readback"` means the controller should reissue
   a controlled readback with a fresh permit, not ask the business for a new field.
4. Acceptance includes all final details again and requests business confirmation.
   Already started, played, or interrupted acceptance cannot be issued again.
5. `record_business_confirmation` permits only a neutral acknowledgement. It does
   not create a confirmed outcome and does not retroactively expire acceptance.
   Use the separate booking/evidence API and semantic verifier to establish the result.

Provisional business speech blocks offer commitment. Stop, stale turns, changed
offers and interruptions must also invalidate controller-owned permits; always
evaluate against current serialized state immediately before playback. The
policy is not a replacement for those controls.

Opening/disclosure, clarification, readback, acceptance, and closing responses use
fixed Spanish templates and validated slots. Prices preserve exact cents; offsets
distinguish repeated DST hours and mainland/Canary time. Arbitrary model-written
speech is not accepted. Output is limited by the shared text schema; unsupported
control characters/markup in a booking name cannot be spoken.

`spanishWaitingForApproval()` and `spanishDeclineOffer()` provide fixed,
non-committing controller replies. `ask_user`, `clarify`, and `deny` decisions do
not themselves contain playback permission; the controller selects the appropriate
safe follow-up and still issues/cancels its own permit. Spanish templates require
fluent-speaker review before live acceptance testing.

## Pure booking API

`src/booking/` exports these functions through the package entry point:

- `reduceBooking(snapshot, event, now, acceptance?)` returns a `BookingUpdate`:
  `bookingState`, `activeOffer`, `pendingApproval`, `outcome`, `conversation`, and
  controller-owned `acceptance` metadata. Persist conversation changes together
  with the booking fields: failed or uncertain bookings and changed offers
  invalidate pending conversation consent. It does not mutate inputs, change
  telephone state, increment revisions, persist data, or issue playback commands.
  Invalid transitions throw `BookingTransitionError`; malformed shared data fails
  schema validation. Terminal outcomes remain unchanged on repeated or late events.
- `checkOfferEvidence(offer, messages)` checks distinct IDs referencing finalized
  business speech. This validates references, not the truth of extracted facts.
- `checkAcceptancePlayback(snapshot, receipt, now)` checks exact attempt/plan/offer
  binding, completed assistant playback, equality with both the permitted text and
  the controlled acceptance template for the current plan and offer, readback and
  offer-evidence ordering, and playback timing. Unknown/prohibited conditions fail.
- `checkConfirmationEvidence(...)` additionally checks final business speech
  after acceptance and a synchronous semantic verifier. Missing, stale,
  provisional, future, contradictory, or unverified evidence cannot confirm.
- `deriveOutcome(snapshot, event, now, acceptance?)` derives a shared `Outcome`
  with deterministic English text and exact integer-cent prices. Unknown duration
  remains unknown; a permitted unknown price is not replaced with zero.

These are internal controller helpers, not new HTTP/SSE contracts or alternatives
to the shared ports. All time values come from the caller; the helpers do not read
the clock or contact providers.

### Controller events and persistence

The reducer consumes **controller events**, never unchecked model proposals:

| Event | Behavior |
| --- | --- |
| `offer_received` | Validate evidence and immutable ID/version; invalidate pending approval on a changed offer. |
| `approval_requested` | Record a backend-created request matching the exact attempt, plan, and offer. |
| `approval_resolved` | Clear a matching request; rejection/expiry ends without booking, invalidation returns to the offer. Approval does not itself speak or grant playback. |
| `readback_started` | Enter readback only with a current offer and no pending approval. Controller policy checks must already have passed. |
| `acceptance_played` | Record a controller-attested receipt for completed authorized output; then await the business. |
| `business_confirmation` | Confirm only after playback, evidence, and semantic checks; otherwise produce uncertainty. |
| `call_finished` | Derive not-booked before possible acceptance; derive uncertainty near acceptance. |
| `uncertainty` | Preserve explicit creation/provider/confirmation uncertainty. |

A changed offer during readback or after acceptance produces uncertainty rather
than starting another booking. Readback may include acceptance, so Stop/failure
during this phase is also conservatively uncertain. New offer/readback/approval
progress requires a connected call. Existing playback/confirmation evidence may
still be reconciled while hangup or provider reconciliation is in progress.

For each serialized controller update:

```ts
const { acceptance: nextAcceptance, ...bookingFields } = reduceBooking(
  snapshot, controllerEvent, serverNow, storedAcceptance,
);
// Controller: atomically persist bookingFields and nextAcceptance with its
// current attempt revision, transcript, telephone changes, and ordered events.
```

`acceptance` is sidecar controller metadata, not a field added to `CallSnapshot`.
Retain it across relevant updates/recovery. Derive the booking result before
atomically publishing terminal telephone state: shared snapshots forbid terminal
calls with pending outcomes. The reducer does not revise final outcomes or
reconstruct deleted evidence for an already confirmed historical booking.

### Playback authority and confirmation meaning

An `AcceptancePlayback` receipt contains the controller-issued `PlaybackPermit`,
the exact `Offer`, readback/acceptance transcript IDs (which can be the same for a
combined reply), and server-observed playback start/completion times. The
controller must verify its own permit state, output correlation, readback content,
current authority, cancellation, and actual playback before supplying the receipt.
A model/browser cannot create a receipt; parsing a permit-shaped object is not
authorization. Policy and grant checks remain separate and must run before speech.
Expiry is checked at playback start, not retroactively after authorized acceptance.

Confirmation requires a synchronous, pure `ConfirmationVerifier` supplied by the
application. It receives the exact offer, cited Spanish evidence, and **all**
business messages after acceptance, returning `affirmed`, `ambiguous`, or
`contradicted`. It must assess actual confirmation of that offer, including any
later corrections. IDs, an assistant sentence, a model confidence score, or an
unconditional `affirmed` callback do not establish meaning. Cited evidence must
include the latest finalized business message; unfinished speech blocks confirmation.

No production Spanish semantic verifier is implemented in this step. Without one,
confirmation fails closed to `uncertain`. Tests use a fixture-specific reviewer
for the expected Spanish sentence. A production verifier and fluent-speaker
evaluation remain integration requirements before live acceptance testing.

### Optional add-on reconciliation

`reduceConversation` records user consent for an exact supplement and total only
after the base appointment is confirmed. The supported supplement uses the vetted
labels `el tratamiento de hidratación` / `the hydrating treatment`; other labels
are rejected by the shared schema. An approved decision returns a non-committing
review reply: it does not accept the supplement or change the booking price.

`prepareAddOnAcceptance(snapshot, decisionId, reservedOfferIdentity, now)` prepares
the amended offer and controlled Spanish acceptance. The caller supplies a fresh
controller-reserved offer identity. Preparation checks the confirmed base booking,
current consent and deadline, exact sum, prohibited conditions, and latest finalized
business evidence. It rejects repeated or interrupted acceptance. The text repeats
the base details, supplement, surcharge, and total; the combined duration remains
unknown. This helper performs no playback or persistence and creates no permit.

The controller persists the returned `AddOnAcceptance` as sidecar metadata, rechecks
current authority/Stop, and issues its own permit bound to the **amended** offer and
exact text. After playback, retain an `AddOnPlayback` receipt with that acceptance,
the permit, transcript message ID, and observed playback start/completion times.

```ts
const acceptance = prepareAddOnAcceptance(
  snapshot, decisionId, reservedOfferIdentity, serverNow,
);
// Controller persists acceptance, authorizes and observes playback, then obtains
// finalized business evidence. It supplies its own authenticated receipt/verifier.
const bookingFields = reconcileAddOn(
  latestSnapshot, playbackReceipt, confirmationMessageIds, serverNow, verifyAddOn,
);
// Atomically persist bookingFields together with transcript/revisions/events.
```

`reconcileAddOn` checks the receipt against the approved terms and exact controlled
text. A synchronous `AddOnConfirmationVerifier` receives the amended offer,
supplement, cited evidence, and all later business messages. Only verified
confirmation updates both `activeOffer` and `outcome.offer` to the total price and
adds the supplement to the English result. Consent/permit expiry is checked at
playback start; later expiry does not undo authorized acceptance.

Reconciliation invalidates any pending conversation consent and returns the updated
`conversation` alongside the booking fields. Persist them atomically so a later
contact request cannot block reconciliation or survive the amended offer.

If acceptance may have started and the call stops, output is interrupted, or
confirmation is missing, call `reconcileAddOn` with the observed receipt and any
available evidence (an empty array is valid for this failure path). It returns an
uncertain result that explains the original appointment was confirmed while the
supplement remains unresolved. Do not finalize that case using only the base
booking reducer or retry the amendment automatically. Keep the sidecar receipt for
recovery. A malformed/stale receipt throws and requires controller reconciliation.

Call `reduceBooking(..., { type: "call_finished", reason }, now)` before publishing
terminal telephone state when only consent is pending. Persist its returned
`conversation` with the booking fields: pending consent becomes invalidated even
when the original appointment is already confirmed. Repeated terminal events do
not add duplicate invalidation records or undo a confirmed appointment.

## Contract imports and ownership

Import public ports, types, and runtime schemas from `@callmate/contracts`, for example:

```ts
import type { BookingPolicyPort, DialoguePort } from "@callmate/contracts";
import { DialogueInputSchema, DialogueProposalSchema } from "@callmate/contracts";
```

Do not import contracts source files by relative path or copy shared definitions.
Implementations belong in `src/planner/`, `src/policy/`, `src/booking/`,
`src/model/`, and `src/language/`. Keep package tests in `test/`, evaluation code
in `evaluation/`, and shared synthetic conversations in `tests/dialogue-fixtures/`
at the repository root.

The server can import the registered package as `@callmate/dialogue`. Its bootstrap constructs and injects the implementations. Dialogue
must not import server internals, write to the database, grant approval, dial,
hang up, or play generated output directly.

## Configuration and lifecycle

The booking helpers, dialogue constructor, and policy require no environment
variables, provider connection, or teardown. Importing them performs no I/O.
The server owns the injected model adapter's credentials and lifecycle: abort
outstanding turn controllers during shutdown, then close the adapter's resources.
The dialogue port owns no persistent connection or background task and needs no
`close()` method. Server environment configuration remains Engineer 2's responsibility.
