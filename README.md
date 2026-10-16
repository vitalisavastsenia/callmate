# CallMate

CallMate is a personal call assistant for handling conversations in a language you do not speak. You describe what you need in English, and the assistant calls a business in Spanish, Russian, English, or Polish, negotiates within your instructions, and reports the result in English.

The first use case is booking a barbershop appointment in Spain. The backend runs in a local Docker container, with Twilio planned for phone calls and speech services. It does not require AWS or Azure accounts or infrastructure.

## Product and engineering documents

Read the documents in this order:

1. [Requirements](docs/requirements.md): personal-use scope, UI, booking rules, and acceptance criteria.
2. [Architecture](docs/architecture.md): local components, Twilio integration, conversation flow, data model, and failure handling.
3. [Technology stack](docs/tech-stack.md): recommended tools, Twilio service choices, estimated costs, and implementation milestones.
4. [Three-engineer delivery plan](docs/mvp-delivery-plan.md): workstreams, task ownership, shared interfaces, dependencies, and PoC/MVP completion criteria.
5. [Three-engineer integration agreement](docs/engineering-contract.md): scope boundaries, deliverables, independent development, handoffs, merge order, and joint acceptance of one app.
6. [Shared interfaces v1](docs/interfaces.md): technical reference for executable schemas, API routes, event/reconnect protocol, and dialogue/voice boundaries.
7. [Backend to UI message contract](docs/ui-message-contract.md): case-by-case HTTP/SSE rules, payload formats, JSON examples, and expected UI behavior.
8. [Twilio account and configuration runbook](docs/twilio-setup.md): account creation, paid/trial limits, Voice number, Spain permissions, credentials, ConversationRelay, callbacks, and connectivity checks for Engineer 2.
9. [Docker backend development](docs/docker-development.md): container startup, configuration, SQLite storage, implemented endpoints, and checks.
10. [Offline Twilio protocol mock](docs/twilio-mock.md): official-format REST/webhook/TwiML/WebSocket adapter tests and a Docker walkthrough.
11. [Mock ConversationRelay development service](mock-conversation-relay/README.md): standalone Docker emulator with an operator browser UI, SDK-compatible Calls subset, signed callbacks/relay handshakes, optional queued dialing, and Connect action continuation checks.

The shared contracts, TypeScript/Fastify backend, and scripted simulator are implemented. Simulator mode supports plan review, Start/Stop, approval decisions, persistent snapshots, replayable SSE, history, and conversation deletion without provider credentials or provider requests. A simple development UI can start manual conversations through the local mock service and display operator replies. These calls share SQLite attempts, transcripts, history, Stop, the active-call reservation, and replayable SSE with the scripted simulator; they carry no booking authority. The Zeus Llama booking/request UI is also present, with a standalone browser simulator and shared HTTP/SSE client. End-to-end integration between that UI and this backend remains to be verified; real calling adapters remain to be built; an optional dialogue/controller path now handles Spanish, Russian, English, and Polish appointment inquiries across 15 templates through the local mock. Completed conversation text and replay events expire automatically after 30 days by default; booking metadata remains in history. Optional explicit test rates provide persisted usage estimates and enforce per-call budgets; real provider charges remain unavailable. Readiness reports database/configuration health, local mock connectivity and enabled capabilities. Simulator mode is required; when the manual mock transport is enabled, its health probe must pass for overall readiness. No real phone calls can start.

The [dialogue library](packages/dialogue/README.md) now provides booking policy, multilingual appointment templates, and Codex CLI/optional OpenAI API model adapters. It is included in Docker builds and offline checks; the backend invokes it for reviewed multilingual appointment mock calls when explicitly configured. See [dialogue-driven local calls](docs/docker-development.md#17-dialogue-driven-local-mock-calls) for setup and current booking limits.

Choose **Conversation language** on Home or the detailed Request page before reviewing a call. The call popup shows the reviewed agent language. The opening introduces the caller as an AI assistant without mentioning the app name and includes the approved name from the plan when supplied. Availability follow-ups ask about the service and reviewed time windows without repeating the introduction. When the offer is within the reviewed constraints, the mock automatically reads it back, sends acceptance after a simulated playback receipt, and waits for a separate business confirmation. The result is labelled as a simulation; offers outside the plan still require approval. Contact replies in any of the four supported languages are retained and translated; they do not change the agent language or approved plan. Choose **Conversation template** for domain-specific fields and questions. Controlled replies have stable IDs and versioned translations stored in SQLite; transcripts retain the rendered text and an English translation. Multilingual dialogue requires **Settings → Backend**, the configured dialogue model, and the local mock relay. The browser and backend scripted simulators retain their existing examples; domain templates and other selected languages require the configured backend dialogue path.

The 15 templates are Haircut, Dentist, Doctor/clinic, Vet, Restaurant, Car service, Plumber, Electrician, Home cleaning, Bank branch, Library, Government office, Legal consultation, Language school, and Parcel collection. They arrange appointments/reservations or information visits within the reviewed scope. See the [profile requirements and limits](packages/dialogue/README.md#conversation-templates).

See [the web UI guide](apps/web/README.md) for its workflow and current integration limits.

## Getting started

```sh
git clone git@github.com:vitalisavastsenia/callmate.git
cd callmate
```

Read [AGENTS.md](AGENTS.md) before making changes. It contains the working instructions for Codex and the project's Git conventions.

Install and start Docker Desktop with Docker Compose. Node.js, npm dependencies, SQLite, and the server all run inside containers; no host Node.js installation is required. From the repository root:

```sh
docker compose up --build -d --wait server
curl http://127.0.0.1:3000/health
```

The private API is published at `127.0.0.1:3000`; the separate callback listener at `127.0.0.1:3001` accepts development mock WebSocket upgrades at `/ws/voice` and signed progress callbacks at `/callbacks/mock/status/:id` when the development/mock gates are enabled. Production provider callbacks remain unavailable. SQLite persists in the `callmate-data` Docker volume.

To answer manual calls through the emulator, start the backend above and then:

```sh
docker compose -f mock-conversation-relay/compose.yaml up --build -d --wait mock-relay
```

Open [the backend UI](http://localhost:3000/), create/sign in to your owner account, enter an initial message, choose Spanish, Russian, English, or Polish, and click **Start conversation**. Click **Open operator window**, answer the ringing call, and type a reply in the mock service. Your initial message appears in the operator transcript; click **Listen** beside it to hear it using a browser/OS voice. Enable **Auto-play backend messages** before answering for automatic playback. The operator's reply appears in the backend UI's response field. **Stop conversation** hangs up the call. Refreshing the page or restarting the backend restores persisted conversation text. Graceful shutdown attempts to hang up active mock calls. After a crash, the backend reconciles stored CallSid/session IDs and ends orphaned mock calls without redialing or replaying text; unresolved calls retain their active reservation. Duplicate, delayed and out-of-order progress callbacks cannot reopen completed calls. Backend-started calls enforce one active slot, idempotent Start/Stop, a duration limit covering preflight/dialing, and a caller-silence deadline; Stop is available while Start is waiting. See the [recovery rules](docs/docker-development.md#10-persistent-correlation-and-recovery), [event handling rules](docs/docker-development.md#11-reliable-mock-status-callbacks), [call controls](docs/docker-development.md#12-call-controls-and-limits), [automatic retention](docs/docker-development.md#13-automatic-conversation-retention), [test-rate usage budgets](docs/docker-development.md#14-test-rate-usage-and-budgets), and [readiness diagnostics](docs/docker-development.md#15-readiness-diagnostics).

You can also create a call directly in [the relay operator UI](http://localhost:8080/) using the default backend URL. Those manual calls receive a development greeting and scripted echo replies; `/end` exercises backend hangup. Backend-started console calls create persisted manual attempts accessible through the shared API/SSE; directly created operator calls remain ephemeral echo checks. Neither path uses AI or makes booking decisions. The root Compose defaults enable the handler with `NODE_ENV=development`, `TELEPHONY_PROVIDER=mock`, and `CALLMATE_MODE=simulator`. See the [relay setup and limits](docs/docker-development.md#8-manual-conversationrelay-development-transport).

Run type checking and offline tests inside a disposable container:

```sh
docker compose --profile checks run --build --rm checks
```

Use `docker compose logs -f server` for logs and `docker compose down` to stop/remove containers while preserving the database volume. See the [Docker guide](docs/docker-development.md) for configuration and endpoint examples.

Follow the [simulator walkthrough](docs/docker-development.md#7-run-a-simulated-call) to create a request, watch SSE, and exercise approvals or failures. Select scenarios with `CALLMATE_SIMULATOR_SCENARIO`; the default is `within_plan`.

An independent [Twilio protocol harness](docs/twilio-mock.md) uses the official SDK and real local HTTP/WebSocket traffic to test provider formats. It is separate from the API/SSE simulator and does not enable live calling. Run its offline walkthrough inside Docker:

```sh
docker compose --profile checks run --build --rm checks npm run demo:twilio-mock --workspace @callmate/server
```

The web workspace is included in the Docker build, type checking, and unit tests. To run the web UI and its database-backed address book in Docker:

```sh
docker compose --profile web up --build -d --wait server web
```

Open [Zeus Llama](http://localhost:5173/) and create the single owner account on first use (username and a 12–128 character password). Later visits require sign-in; **Sign out** is above the navigation. Login also protects the backend console at port 3000, including simulator mode. The account and 12-hour sessions persist in SQLite. There are no default credentials, public registration, or cloud identity services. See [authentication and recovery](docs/docker-development.md#16-owner-login-and-sessions). The **Contacts** button opens the address book: create, search, edit, or delete contacts with a name, phone number, and IANA timezone (Europe/Madrid by default), plus optional tone preferences and notes. Contacts persist in the backend SQLite volume and are available in the Home/Request destination picker, including when calls use the browser simulator. Previous browser-only contacts can be explicitly imported from Contacts. Editing or deleting a contact preserves values already copied into requests and history.

Calls default to the browser simulator; contacts require the backend in both call modes. The backend development console remains at port 3000. Select **Settings → Backend** for server-managed calls. Reviewed mock calls require a ready dialogue engine; they never silently fall back to scripted results. To use your existing Codex login in Docker, follow the [Codex setup](docs/docker-development.md#17-dialogue-driven-local-mock-calls). Optional dialogue mode handles Spanish, Russian, English, and Polish appointment inquiries across 15 templates through the mock. Call budgets follow the backend settings currency (USD or EUR); service prices remain EUR. Changing budget currency requires another plan review and explicit re-entry of edited amounts. Manual-call history belongs in the console.

Starting a call opens a popup with the agent's phrases, the other side's replies, translations, and recorded agent actions/approval reasons. Stop and exact-offer approval controls are available there. Minimize it to use the rest of the app; **View call** reopens the same conversation without dialing again. The finished conversation and result remain visible until you close the popup or open Summary. **Call again** starts a new attempt with the same reviewed request after the call ends. If the backend adjusts the plan, review the updated details before calling.

To run the dialogue library's offline evaluation in Docker:

```sh
docker compose --profile checks run --build --rm checks npm run evaluate --workspace @callmate/dialogue
```

The [dialogue guide](packages/dialogue/README.md) describes standalone model examples. Default app startup and offline checks do not run Codex, send model requests, or enable real calls. Enabling the optional server dialogue provider sends call context through Codex CLI with your saved ChatGPT login or the configured OpenAI API model; see the setup guide above.

## Repository files

- `README.md`: project overview and setup instructions.
- `AGENTS.md`: Codex workflow, branch naming, commit conventions, and verification expectations.
- `.gitignore`: excludes local environment files, operating-system artifacts, and temporary files.
- `docs/`: product requirements, architecture, and technology decisions.
- `packages/dialogue/`: booking policy, dialogue planning, localized templates, model adapters, and offline evaluations.
- `packages/contracts/`: shared runtime schemas, types, routes, adapter interfaces, fixtures, and contract checks.
- `apps/web/`: React/Vite/Tailwind UI, browser simulator, shared HTTP/SSE client, unit and browser tests.
- `apps/server/`: Fastify API/SSE, SQLite migrations/storage, simulator/controller, fake adapters, and server tests.
- `mock-conversation-relay/`: independently runnable development emulator and operator UI at `localhost:8080`; see its README for backend wiring and tests.
- `Dockerfile`, `compose.yaml`, `.dockerignore`: container build, runtime, persistent data volume, and build-context exclusions.

## Development workflow

Use `main` as the primary branch. During the current integration phase, work directly on `feat/app-integration` without creating separate feature or fix branches unless explicitly requested. This temporary workflow remains in effect until the user changes it. If a separate branch is requested and a task has an issue key, include it after the branch type, for example `feat/odyssey-2026-add-call-history`.

Use Conventional Commits by default, for example `feat(calls): add call history`. Explicitly requested commit messages take precedence.

Keep commits focused, inspect the staged diff, and run the container checks before committing. Never commit credentials or local `.env` files; use placeholder values in `.env.example`.
