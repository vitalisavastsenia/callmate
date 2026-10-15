# CallMate agreement for three engineering scopes

Status: proposed working agreement for engineer review. Updated: 2026-10-15.

Three engineers deliver one local CallMate application: a React UI, a Node.js server with SQLite and Twilio, and a dialogue module loaded by that server. Each scope must be independently developable against shared contracts and test doubles, then replaceable with its real implementation without changing the other scopes.

This agreement defines responsibilities, handoffs, and integration gates. [Shared interfaces v1](interfaces.md) defines the exact data shapes, HTTP routes, events, and TypeScript ports. The [delivery plan](mvp-delivery-plan.md) assigns implementation tasks; [requirements](requirements.md) defines product acceptance.

The [backend to UI message contract](ui-message-contract.md) specifies which HTTP responses/events are sent for each situation, their formats, JSON examples, and the corresponding UI behavior.

## 1. Shared product and runtime

The first integrated PoC takes an English haircut request, obtains deliberate user approval, calls a consenting Spanish-speaking test contact through Twilio, negotiates within the approved constraints, and shows an English result. The personal MVP adds alternative-offer approvals, history, calendar export, retention/deletion, usage, and recovery.

All scopes use the same repository, npm workspace, shared schemas, attempt IDs, and simulator scenarios. There is one application backend and one authoritative database. The dialogue module runs inside that backend; it does not introduce another HTTP service. The UI accesses the backend through the private HTTP/SSE API.

The implementation baseline remains Twilio ConversationRelay with a text LLM. OpenAI Realtime with Media Streams is an alternative to evaluate, not a change an engineer may make independently. Engineers 2 and 3 must first agree its voice boundary, commitment controls, cancellation behavior, and acceptance test, and update the architecture and interfaces. The UI contract should remain stable.

Local infrastructure requires no AWS or Azure. Credentials remain in local server configuration. Only the Twilio callback listener is exposed through a tunnel; the UI, private API, settings, and history stay private. Simulator mode is the development default and cannot dial.

## 2. Ownership and deliverables

| Scope | Owned paths | Required handoff | Outside this scope |
| --- | --- | --- | --- |
| Engineer 1 — UI | `apps/web/`, `tests/e2e/` | Request/review screens; typed API client; live call and Stop; approval/result/history/settings views; confirmed-booking calendar export; browser acceptance tests and UI setup notes. | Twilio/OpenAI SDKs, database access, booking authorization, a separate application backend. |
| Engineer 2 — backend and integration | `apps/server/`, `tests/provider-fixtures/`; root tooling and shared contracts | Local API and SSE; SQLite/migrations; authoritative call controller; fake and real telephony/voice adapters; provider callback listener; application bootstrap; startup/recovery documentation. | Independent UI implementation or a second copy of Engineer 3's policy and prompts. |
| Engineer 3 — dialogue and booking | `packages/dialogue/`, `tests/dialogue-fixtures/` | Implementations of `DialoguePort` and `BookingPolicyPort`; internal booking-state logic; Spanish replies; English translations/results; deterministic dialogue fixtures and policy evaluations. | Dialing/hangup, Twilio sessions, database writes, approval grants, or directly playing generated output. |

Engineer 2 is the integration coordinator and maintainer of root manifests, lockfile, shared TypeScript/build configuration, `packages/contracts/`, migrations, and environment examples. Engineers 1 and 3 request root changes through Engineer 2 instead of creating competing configurations. Each engineer owns fixes and tests in their component; Engineer 1 coordinates the integrated browser demo.

`packages/contracts/` and `apps/server/` now exist. The Docker backend implements persisted simulator calls, HTTP/SSE, approvals, history/deletion, SQLite settings, and separate private/callback listeners. Fake adapters implement the shared ports; UI and live provider/dialogue wiring remain target deliverables. See [Docker development](docker-development.md).

## 3. Agreements at each connection

| Connection | Producer delivers | Consumer must do | Acceptance at the boundary |
| --- | --- | --- | --- |
| UI → backend | Engineer 1 sends the exported request schemas to the routes defined in `api`, including idempotency keys for Start and approval decisions. | Engineer 2 validates input, persists authority, enforces one call, and returns the documented snapshot or error. | Repeated Start cannot create a second attempt; stale approvals produce the documented conflict. |
| Backend → UI | Engineer 2 supplies validated snapshots, ordered SSE events with replay, readiness, and safe errors. | Engineer 1 renders server state, deduplicates events, resynchronizes gaps, and distinguishes call termination from booking success. | Refresh/reconnect restores the same attempt; uncertain outcomes never render as confirmed. |
| Controller → dialogue | Engineer 2 passes `DialogueInput` and an `AbortSignal` to `DialoguePort.propose`. | Engineer 3 returns a schema-valid `DialogueProposal` with evidence references; cancellation stops obsolete work. | Scripted Spanish input yields a typed proposal; malformed model output takes a clarification/failure path. |
| Controller → policy | Engineer 2 supplies the current snapshot, candidate action, server time, and a server-resolved exact-offer grant to `BookingPolicyPort.evaluate`. | Engineer 3 returns allow with controlled Spanish text, ask-user, clarify, or deny, with no external side effects. | A price above the limit cannot produce acceptance without a valid grant; excluded payments remain denied. |
| Controller → voice | Engineer 2 validates current authority, creates a playback permit, and invokes its own voice adapter. | The adapter checks controller-owned permit state and supports cancellation; model output cannot bypass this step. | Stop, changed offer, or obsolete turn prevents later acceptance playback. |
| Providers → controller | Engineer 2 authenticates and correlates callbacks, normalizes utterance/interruption/failure events, and persists changes. | The controller serializes updates and invokes dialogue/policy; Engineer 3 consumes provider-independent inputs. | Duplicate/late callbacks cannot regress terminal state or confirm a booking without business evidence. |

Import direction is `web → contracts` and `server → contracts + dialogue`, with `dialogue → contracts`. The UI never imports server/dialogue internals, and dialogue never imports server code. Provider-specific events and credentials stay behind their adapters. Shared schemas are imported rather than copied.

The server bootstrap is the composition point. Engineer 2 constructs the real or fake telephony and voice adapters, obtains Engineer 3's dialogue/policy implementations, injects them into the controller, and mounts the API. Engineer 3 documents how to construct its implementations, required non-secret configuration, provider timeout behavior, and teardown. Module imports must not start calls, open databases, or contact providers.

## 4. Baseline before separate branches

Engineer 2 prepares a shared foundation change; Engineers 1 and 3 review the boundaries they consume. Before parallel feature work starts, the foundation must provide:

1. One installable workspace with web, server, dialogue, and contracts packages, compatible Node/TypeScript settings, and documented package imports.
2. Contract version 1, validated synthetic fixtures, API/error/event examples, and the port definitions linked above.
3. An application shell that wires replaceable adapters and can run without provider credentials. Fake telephony and fake dialogue must be clearly selected; missing live configuration must never fall back to dialing.
4. Documented commands for local development, build, type checking, and tests, including how the browser reaches the private API and how live mode is enabled deliberately.
5. A safe environment example containing placeholders only, private runtime-data paths, ignore rules, and no recording by default.

All engineers branch from the same foundation commit after it is integrated through the repository's normal authorized workflow. Record that commit and contract version in each handoff. Follow `AGENTS.md` for branches, commits, reviews, and remote publication; this agreement does not authorize Git pushes or merges.

Run `docker compose up --build -d --wait server` for the backend/simulator and `docker compose --profile checks run --build --rm checks` for contracts/server checks inside Docker. The root workspace commands build/type-check/test both packages within that environment. UI and real dialogue workspaces, and their combined browser flow, remain deliverables.

## 5. Independent development and substitutes

| Engineer | Develops against | Must supply for others |
| --- | --- | --- |
| 1 | Shared fixtures and a mock HTTP/SSE layer matching the exported API. | UI flows using the same scenario IDs as backend acceptance tests; no component changes when switching from mock API to local server. |
| 2 | A deterministic fake dialogue/policy implementation plus fake telephony/voice adapters implementing the shared ports. | A server simulator with controllable success, alternative, rejection, disconnect, and timeout scenarios; API/SSE available without credentials. |
| 3 | Scripted `DialogueInput` and snapshots, a controllable clock, and a fake model response source. | Dialogue/policy implementations injectable into the server, scripted conversations, expected decisions, and evaluation commands that do not require a telephone call. |

Engineer 2 owns the shared scenario identifiers and server simulator behavior. Engineers 1 and 3 contribute fixtures; synthetic data must be validated against the same schemas. Existing exported fixtures are starting data, not a completed simulator. Never dial a fixture number.

The minimum shared scenario set is: within-plan confirmation; no available slot; changed time or price requiring approval; rejection/expiry of approval; changed offer invalidating approval; business disconnect after ambiguous acceptance; duplicate Start; and Stop during a pending model reply. PoC may initially end out-of-plan cases without booking; interactive approval is required for the MVP gate.

## 6. Integration and merge sequence

Integration begins with the first working slice. Engineer 2 maintains the assembly checklist and reports whether the current combined app can run in simulator and live modes. Each engineer synchronizes with the integrated baseline before handoff and resolves conflicts in their scope; shared-file conflicts go to Engineer 2. Each working day, demonstrate the current combined simulator flow and identify the next missing connection.

| Order | Change and owner | Required evidence before the next gate |
| --- | --- | --- |
| 0 | Shared foundation — Engineer 2, reviewed by all. | Fresh checkout installs; modules import contracts; fake adapters can be wired without credentials. |
| 1 | Simulator/controller/API — Engineer 2; UI request-to-result slice — Engineer 1. Integrate the server API before its dependent UI client. | In one running app, Start creates an attempt, SSE updates the UI, Stop ends it, and a simulated result is displayed. |
| 2 | Dialogue/policy — Engineer 3; server wiring — Engineer 2. | Replace fake dialogue through the existing ports. A scripted Spanish conversation reaches a supported outcome and the policy rejects unauthorized commitments. |
| 3 | Real provider adapter — Engineer 2; joint PoC test. Connectivity spike can run earlier in parallel. | The same UI/controller/dialogue flow completes a real Twilio call with a consenting test contact. No separate demo backend is accepted. |
| 4 | Approvals and recovery — all three scopes, in small compatible changes. | Exact-offer approval works across UI, API, policy, and voice; stale/expired decisions, reconnects, cancellation, and uncertain outcomes pass integrated scenarios. |
| 5 | Personal MVP completion — all three scopes. | History, deletion/retention, confirmed-only calendar export, usage, and supervised Spanish call evaluation meet the delivery-plan definition of done. |

A component is ready for handoff when it is wired into the combined app and its boundary checks pass. Screenshots, a standalone dialogue script, or a ringing telephone are useful progress evidence but do not independently satisfy an integration gate.

## 7. Shared contract changes

The proposing engineer supplies the changed field/route/port, reason, affected consumers, updated fixture, and compatibility impact. Engineer 2 maintains the definition; Engineer 1 reviews browser boundaries, Engineer 3 reviews dialogue boundaries, and Engineers 2 and 3 jointly review booking authority and playback changes.

Update schemas, technical interface documentation, fixtures, and affected tests together. Breaking changes require a protocol version change and coordinated consumer updates under the policy in [Shared interfaces](interfaces.md#8-change-process). Integrate compatible foundations before dependent code; do not merge a consumer that requires a contract absent from the integration branch. An engineer blocked on an unagreed change continues with an adapter or mock matching the current baseline.

## 8. Scope handoff checklist

| Scope | Required evidence |
| --- | --- |
| UI | All agreed screens work against simulator HTTP/SSE; errors and expiry are visible; reconnect restores state; Stop is accessible; no browser provider secrets or independent booking decisions. |
| Backend | Real/fake adapters share ports; signatures and callback correlation are checked; idempotency, persistence, replay, one-call reservation, Stop, and restart reconciliation are tested; private routes stay off the public listener. |
| Dialogue | Shared ports/schema validation pass; proposed booking details cite evidence; policy tests cover limits, grants, ambiguity, cancellation, and changed offers; Spanish replies and English summaries receive fluent-speaker review before live acceptance. |
| All | Setup commands and configuration documented; relevant checks run with results recorded; known limitations named; no copied schemas; changes remain within ownership or have affected-owner review. |

Use this handoff record in each implementation PR or local review:

```text
Scope and branch:
Foundation commit and contract version:
Delivered behavior and owned paths:
Consumed and exported routes, events, or ports:
Configuration changes and setup commands (no secret values):
Checks run and actual results:
Combined-app scenario and reproduction steps:
Dependent changes and integration order:
Known limitations and follow-up owner:
```

Before any authorized remote push, review all outgoing commits for secrets according to `AGENTS.md`, including intermediate revisions, configuration, fixtures, documentation, and commit messages.

## 9. Joint acceptance demonstration

Engineer 1 runs the UI flow, Engineer 2 verifies provider/controller state and recovery, and Engineer 3 verifies conversation meaning and authority. All three inspect the same attempt and result.

1. From a fresh checkout, follow the documented setup, start simulator mode without credentials, and submit an English request with explicit date/timezone, price limit, and booking authority.
2. Review and deliberately start once. Demonstrate duplicate submission protection, live Spanish text/English translation, and browser reconnect to the same attempt.
3. In the MVP scenario, receive an offer above the price limit. Show that no acceptance is played before approval; demonstrate both an approved offer and an expired/rejected or changed offer.
4. Confirm only when final business evidence supports the exact authorized appointment. Disconnect during an ambiguous exchange and show an uncertain result without automatic redial.
5. Stop while a model reply is pending. Verify no late acceptance is played and that the provider call ends or remains visibly awaiting reconciliation.
6. Enable live configuration deliberately and run the request-to-result PoC with a consenting Spanish-speaking test contact through Twilio. Inspect critical details with a fluent speaker and record actual latency and available cost evidence.
7. For MVP acceptance, reopen local history, export a confirmed appointment, delete conversation text, and verify retention/recovery behavior using the documented scenarios.

The PoC gate requires the integrated real call and bounded booking behavior. The MVP gate additionally requires every applicable scenario above and the delivery plan's full definition of done. A working simulator alone does not complete the real-call PoC.
