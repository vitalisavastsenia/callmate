# CallMate delivery plan for three engineers

Status: original delivery allocation and future real-call gates; implementation checkpoint updated 2026-10-16. Based on [requirements](requirements.md), [architecture](architecture.md), and the [technology stack](tech-stack.md).

**Implemented checkpoint:** all four application workspaces exist and are integrated. UI/backend simulations, HTTP/SSE, SQLite recovery/retention, contacts, Agreements/calendar/deletion, four dialogue languages/15 templates and Codex/OpenAI/Claude settings are present. Default Compose has two services: `zeus-llama` and `mock-relay`. Twilio selection is explicitly unavailable; real telephony, attested playback, production confirmation verification, provider billing and the supervised pilot remain open. Existing local/browser tests do not complete the real-call PoC below.

Current work stays on `feat/app-integration` under [AGENTS.md](../AGENTS.md); the original parallel-branch instructions below are historical planning guidance.

## 1. Deliver two usable increments

**PoC:** From the local UI, approve a haircut request, call a consenting Spanish-speaking test contact through Twilio, negotiate an appointment within the approved limits, and display an English result. A scenario outside the limits is declined or ended without booking. Real Twilio connectivity and a real dialogue are necessary; a simulated conversation alone is not a completed PoC.

**Personal MVP:** Add live approval of alternatives, resilient call handling, persistent history, calendar export, retention/deletion, and usage visibility. Validate with a small supervised barbershop pilot. This increment covers the mandatory functional requirements in the requirements document.

Both increments use one local app, SQLite, one active call, English instructions, Spanish calls, Twilio Programmable Voice + ConversationRelay, and a text LLM. AWS/Azure infrastructure, native mobile apps, payments, live audio monitoring, multi-user accounts, and rescheduling remain outside scope. Simple keypad menus are an optional follow-up.

## 2. Ownership

| Engineer | Scope | Owns | Key deliverable |
| --- | --- | --- | --- |
| Engineer 1 | UI and user workflow | React UI, browser API client, simulated UI data, calendar export, browser tests | A usable interface from request to result, including clear approvals and uncertainty. |
| Engineer 2 | Application backend and Twilio | Local runtime, SQLite/migrations, HTTP/SSE, callback listener, Twilio adapter, call state, limits/recovery | A real call that starts once, is observable, and ends safely. |
| Engineer 3 | Dialogue and booking decisions | LLM adapter, typed dialogue actions, booking policy/state, Spanish responses, English summaries/translations, dialogue evaluation | A conversation that can arrange the requested appointment without exceeding authority. |

Engineer 2 coordinates integration and owns root tooling. Each engineer owns tests and setup notes for their work; integration is continuous rather than a separate final handoff. Engineer 1 leads the end-to-end demo, Engineer 2 provider failure drills, and Engineer 3 review of booking accuracy with a fluent Spanish speaker.

## 3. Agree interfaces before parallel implementation

The [three-engineer integration agreement](engineering-contract.md) is the working contract between the scopes: what each engineer delivers, how they develop independently, who assembles the app, and which integration gates each handoff must pass. Review it together before splitting implementation branches from the common foundation. It is proposed for review; no engineer sign-off is implied.

Its technical appendix is [Shared interfaces](interfaces.md), with executable schemas/types in [`packages/contracts`](../packages/contracts/src/index.ts), fixed API routes, adapter boundaries, example data, and offline checks. Engineer 2 maintains shared contract files; changes require review from affected consumers.

| Contract | Required content |
| --- | --- |
| Approved plan | Plan ID/version; destination; service; booking name; explicit local availability and timezone; maximum service price/unknown-price policy; allowed shared details; booking permission; call duration/cost limits. |
| Call snapshot | Local attempt ID; telephone state; separate booking outcome; active offer/version; approval deadline; last event sequence; estimated/available final cost. |
| Events | Versioned envelope with event ID, attempt ID, sequence, timestamp, and typed payload. Types include call status, conversation text/translation, offer, approval required/resolved, booking result, usage, and recoverable/terminal error. |
| Dialogue input/output | Finalized business utterance + current plan/booking state in; typed candidate action + extracted offer + evidence IDs out. No credentials or direct Twilio access. |
| Approval | Exact attempt/offer/plan versions, approve/reject decision, and expiry. Backend checks these atomically before changing authority. |
| Provider adapter | Start call, end call, send approved text, receive utterance/interrupt/end events, and query provider call state. A fake adapter implements the same interface. |

Engineer 2 owns the authoritative call lifecycle, persistence, deadlines, and final policy invocation. Engineer 3 supplies a booking-state reducer and policy functions without database or telephony side effects. Engineer 1 renders snapshots/events and sends commands; the browser never decides whether a booking is authorized.

The local API routes and error shapes are now specified in [Shared interfaces](interfaces.md#4-private-http-api) and exported as `api` from the contracts package. Review changes through the shared contract rather than independently choosing route names during implementation.

Original code ownership (all four application packages now exist; test paths below include planned provider-fixture ownership):

```text
apps/web/                  Engineer 1
apps/server/               Engineer 2
packages/contracts/        Engineer 2; reviewed by all consumers
packages/dialogue/         Engineer 3
tests/e2e/                 Engineer 1; fixes owned by the failing component
tests/provider-fixtures/   Engineer 2
tests/dialogue-fixtures/   Engineer 3
```

## 4. Engineer 1: UI and user workflow

| Task | Increment | Deliverable and acceptance | Dependency |
| --- | --- | --- | --- |
| UI-01: App shell and client | PoC | Local React/Vite shell, API client, connection indicator, and simulator mode clearly distinguished from real calling. UI can render shared example events without provider access. | Shared contracts and root scaffold. |
| UI-02: Request and review | PoC | Business/number, haircut request, booking name, explicit availability/timezone, price policy, and shareable details. Review card requires deliberate Start; validation errors are readable. Separate service price from call cost. | Approved-plan schema. |
| UI-03: Active call and Stop | PoC | Status, Spanish text, English translations, prominent Stop, and result view. Do not show success on telephone completion alone; make an uncertain outcome obvious. | Fake adapter first; backend SSE and start/stop later. |
| UI-04: Offer approvals | MVP | Exact alternative, differences from the plan, expiry countdown, approve/reject, and stale-offer handling. A missed approval or disconnected UI cannot imply acceptance. | Versioned approval API and dialogue offers. |
| UI-05: History and calendar | MVP | Local history/detail/deletion, confirmed booking card, `.ics` download only for confirmed bookings, timezone preservation, and no invented appointment duration. | Backend queries/deletion and final booking schema. |
| UI-06: Settings and end-to-end tests | MVP | Readiness, limits/retention settings, cost labels, keyboard access, reconnect behavior, and Playwright coverage from review to result using fake providers. Validate narrow layout. | Config API and integrated scenarios. |

Engineer 1 can complete most visual work against fixtures while the backend and dialogue modules are being built. Browser microphone access and live telephone audio are not required.

## 5. Engineer 2: backend, persistence, and telephony

Begin the account/Console portion early using the [Twilio setup runbook](twilio-setup.md). The account owner handles identity, billing, purchases, and terms; Engineer 2 owns configuration and verification. BE-00 can proceed alongside backend/simulator work; real ConversationRelay testing requires paid-account eligibility and an implemented callback listener.

| Task | Increment | Deliverable and acceptance | Dependency |
| --- | --- | --- | --- |
| BE-00: Twilio account and Console setup | PoC, start early | Account created/verified and upgraded for ConversationRelay; eligible Voice number/compliance; Spain geo permissions; AI/ML terms; private API credentials; inbound-call policy. Record readiness/blockers without secrets using the runbook. | Account owner, billing/identity information, and number availability. |
| BE-01: Bootstrap and local persistence | PoC | Workspace/tooling, shared schemas, Fastify local API and separate callback listener, SQLite migrations, private data path, redacted logs, safe `.env.example`, and ignore rules for runtime data. Document actual start/test commands. | Joint kickoff decisions. |
| BE-02: Simulator and event stream | PoC | Fake telephony adapter, call snapshots, ordered/replayable SSE, and deterministic test scenarios. Refreshing the UI restores state instead of starting a call. | Contracts and initial schema. |
| BE-03: Twilio connectivity spike | PoC, earliest external risk | Secure tunnel; signed HTTP and WSS validation; outgoing call to an approved test number; Spanish ConversationRelay voice; safe end/fallback path; verified caller ID/account readiness. Follow the runbook and do this before polishing the full UI. | BE-00, callback listener, and consenting test endpoint. |
| BE-04: Controlled call lifecycle | PoC | Persist approved plan, reserve one active-call slot, prevent duplicate Start, set local/provider duration caps, wire dialogue adapter, execute Stop, and keep call outcome separate from booking outcome. An ambiguous dial timeout never triggers blind retry. | BE-01/03 and dialogue interface. |
| BE-05: Approval/persistence APIs | MVP | Versioned approval decisions, deadlines, local history/deletion, retention, and cost/usage storage. Backend invokes booking policy before any acceptance text is sent. | Dialogue approval rules and booking schema. |
| BE-06: Failure recovery and usage | MVP | Duplicate/out-of-order callback handling, late events, network/relay failures, restart reconciliation, orphaned-call handling, and estimated versus available settled usage. Tests prove terminal states do not regress. | Real Twilio adapter and persisted attempts. |

BE-01 and BE-02 now provide a runnable Docker backend, SQLite settings/plans/call/event storage, deterministic simulator scenarios, private HTTP/SSE, idempotent Start, one-call reservation, Stop, approval/version/expiry cases, restart finalization, and history/deletion. See [Docker development](docker-development.md) for the walkthrough. The backend-started manual mock path now also shares persisted attempts, transcripts, history, Stop, the global active-call reservation and SSE with the simulator, using an explicit `manual_mock` snapshot with no booking plan or authority. The manual mock path persists provider/CallSid/session correlation and creation intent, reconciles after restart, and ends orphaned calls without redial; unidentified or unconfirmed calls retain the reservation. Signed local progress callbacks now persist ordering with atomic snapshot/events, ignore duplicates and stale deliveries, and keep terminal results immutable across restart, deletion and delayed REST responses. Backend call controls now enforce the shared one-call reservation, idempotent Start/Stop, frozen duration limits, caller-silence deadlines and queued/ringing cancellation, including in-flight creation/Answer races. Automatic retention now purges expired terminal transcript text and replay payloads at startup, every minute and on settings changes, preserving booking metadata, history and idempotency. Explicit opt-in test rates now persist elapsed usage with frozen rates/budgets, emit usage updates, and enforce per-call budgets across simulator/manual mock flows while keeping real provider charges unavailable. Readiness now checks database/configuration and local mock health with explicit enabled/ready capability flags; it keeps live calling/dialogue/billing disabled. These remain development paths; Twilio connectivity, real dialogue/policy integration and real-provider pricing/caps/reconciliation remain subsequent work.

Engineer 2 owns retries and provider reconciliation. Neither another engineer's module nor an LLM may independently initiate a second call. Public tunnel routes must never expose the personal UI, call-start API, settings, or history.

## 6. Engineer 3: conversation and booking logic

| Task | Increment | Deliverable and acceptance | Dependency |
| --- | --- | --- | --- |
| AI-01: Dialogue fixtures and booking state | PoC | Typed actions, pure booking-state reducer, and synthetic Spanish conversations for available/unavailable slots, price questions, refusal, and ambiguity. No provider credentials needed. | Shared plan/offer contracts. |
| AI-02: LLM extraction adapter | PoC | Structured output for service/date/time/price/conditions with utterance evidence; invalid, partial, or ambiguous model output results in clarification or unresolved state. Never treat schema validity as factual correctness. | AI-01; configured LLM for provider tests. |
| AI-03: Booking policy and Spanish responses | PoC | Deterministic validation of dates, timezone, price policy, shared data, and permission. Approved templates for disclosure, questions, readback, acceptance, refusal, and ending. Out-of-scope offers cannot produce acceptance. | AI-01/02 and approved-plan contract. |
| AI-04: Turn handling and English output | PoC | Finalized utterance processing, translation, controlled reply selection, English result, explicit business-confirmation evidence. Late/cancelled turns cannot emit acceptance; interruption does not imply a whole reply was heard. | Relay events from fake adapter, then BE-03/04. |
| AI-05: Alternatives and approval semantics | MVP | Changed-offer detection, exact-offer approval, expiry/rejection behavior, revalidation before speaking, and preservation of uncertainty around disconnects. | AI-03 and BE-05/UI-04 integration. |
| AI-06: Spanish evaluation suite | MVP | At least 20 distinct scripted scenarios including accents/noisy telephone input, interruptions, changed offers, ambiguous names/times, unknown prices, misleading instructions, and connection loss. Measure actual turn latency and inspect critical-detail accuracy. | Simulated tests first; consenting test calls after integration. |

Engineer 3 does not own dialing, database writes, or arbitrary external tools. A fluent Spanish review is a test prerequisite for judging dialogue quality; translation output alone cannot validate itself.

## 7. Integration order and gates

| Gate | Work in parallel | Required demonstration |
| --- | --- | --- |
| G0: Contracts and scaffold | All agree schemas and sample events; Engineer 2 scaffolds; Engineers 1 and 3 prepare UI/dialogue fixtures. | All modules compile against the same contracts; simulator data can drive the UI. |
| G1: Two early proofs | Engineer 1 builds request/live/result UI; Engineer 2 proves real Twilio connectivity; Engineer 3 proves a text-only Spanish booking flow and policy. | A test telephone rings and speaks Spanish; separately, a scripted dialogue reaches a valid booking outcome without exceeding limits. |
| G2: Working PoC | Connect the UI, call controller, dialogue engine, and persistence. | User starts from the UI; a consenting Spanish-speaking contact offers an allowed appointment; assistant reads back details, receives confirmation, and returns the correct English result. An out-of-policy alternative is declined without booking. |
| G3: Personal MVP | Engineer 1 completes approvals/history/export; Engineer 2 completes recovery/usage; Engineer 3 completes alternative handling/evaluations. | Approved alternative succeeds; stale/rejected/unanswered alternatives do not. Restart, Stop, duplicate callbacks, and disconnect cases pass. Mandatory FR-01 through FR-14 are covered. |
| G4: Supervised pilot | All run/review a small user-initiated barbershop pilot and fix observed issues. | Correct confirmed details or honest unresolved outcome, measured delays/costs, and documented startup/recovery instructions. |

The main dependency chain is **Twilio connectivity → integrated controlled dialogue → explicit confirmation → failure/approval hardening → real pilot**. Frontend polish must not delay the first connectivity test. A simulator remains available after integration so ordinary development does not place calls.

## 8. Definition of done

- Fresh local checkout can be installed and started using documented commands; real-calling prerequisites are explicit and secrets remain outside Git.
- A complete request-to-result flow works with fake providers and with a consenting real test contact.
- Booking authority is enforced on the server. No unauthorized acceptance occurs in the regression suite; failures block real-business testing.
- Confirmed outcomes match the business's explicit confirmation; ambiguous cases remain uncertain and cannot cause automatic rebooking.
- One active call, deliberate Start, acknowledged Stop, and provider duration limits are verified. Actual call/relay interruption and restart behavior are tested.
- Live text, approvals, local history, deletion/retention, calendar export, and cost labels work for the MVP; recording stays disabled.
- Tests have a named owner per workstream. An integrated browser test is not a substitute for real Spanish telephone validation.

## 9. Coordination and scope control

Use focused branches such as `feat/request-review-ui`, `feat/twilio-relay-adapter`, and `feat/booking-policy`, following `AGENTS.md`. These are descriptive examples, not invented issue IDs. Root tooling, migrations, and shared contracts have one maintainer to reduce conflicts. Review contract changes before dependent work is merged.

Integrate small increments throughout development and run the same fake-provider demo frequently. Keep PoC and real-call modes visibly separate. Before every remote push, follow the outgoing-history secret checks in `AGENTS.md`.

If provider account/number readiness blocks Engineer 2, the UI and dialogue work can continue against the simulator, but the PoC remains incomplete until a real call works. Estimate delivery dates after that connectivity spike and the first dialogue evaluation; this plan does not assume provider setup or Spanish voice quality is already proven.
