# CallMate

CallMate is a personal call assistant for handling conversations in a language you do not speak. You describe what you need in English, and the assistant calls a business in Spanish, Russian, English, or Polish, negotiates within your instructions, and reports the result in English.

The first use case is booking a barbershop appointment in Spain. The current Zeus Llama build runs the UI and backend together in one Docker container, alongside a local mock relay container. All current calls are simulated; Twilio is planned for real phone calls and speech. No AWS or Azure infrastructure is required.

Start with [Installation](#installation), then [How to use Zeus Llama](#how-to-use-zeus-llama). See [Common setup problems](#common-setup-problems) if calls are unavailable, or [Stop, restart and update](#stop-restart-and-update) for everyday commands.

## Installation

### 1. Prepare your computer

Install Git and Docker Desktop, then start Docker Desktop. Docker Compose must support `docker compose up --wait`. All application dependencies, Node.js and SQLite run in Docker; you do not need to install Node.js or run `npm install` on your computer. Allow Docker to access the internet for the initial image build.

Clone the repository using an SSH key with repository access and select the current integration branch:

```sh
git clone git@github.com:vitalisavastsenia/callmate.git
cd callmate
git switch feat/app-integration
```

If GitHub SSH is not configured, use `https://github.com/vitalisavastsenia/callmate.git` as the clone URL and authenticate with your GitHub account when required. Features described here must be present in your checkout; local commits on another developer's computer are unavailable until published.

### 2. Build and start the project

From the repository root, run:

```sh
docker compose up --build -d --wait
docker compose ps
curl http://localhost:3000/health
```

The default setup needs no `.env` file. It starts two services:

| Service | Open in your browser | Purpose |
| --- | --- | --- |
| Zeus Llama | [localhost:3000](http://localhost:3000/) | Main web app and backend API |
| Mock relay | [localhost:8080](http://localhost:8080/) | Act as the business answering a simulated call |

The default ports 3000, 3001 and 8080 must be available. Port 3001 is the callback/WebSocket listener, not another web app. These services bind to your computer's loopback interface. Each colleague can run their own installation locally.

### 3. Create your account

Open [Zeus Llama](http://localhost:3000/) and create the owner account with a username and a password of 12–128 characters. There are no default credentials. Later visits require sign-in; one owner account protects this installation. Use the same hostname consistently, because `localhost` and `127.0.0.1` have separate browser sessions and storage.

## How to use Zeus Llama

### Choose a call mode

Open **Settings → Calling** and choose a mode:

| Mode | What it does | What you need |
| --- | --- | --- |
| **Simulator** | Runs scripted examples in your browser; no call appears in the mock operator | Running app; no LLM credentials |
| **Backend** with **Mock service** | Runs an LLM conversation through the mock relay; you answer as the business in the operator window | Configured LLM provider and the mock service |

The default build selects Simulator. To try the interface immediately, keep that mode and choose a **Simulated outcome** in Settings. Scripted examples support the haircut template in Spanish. Use Backend for the other templates and conversation languages. **Twilio** is marked **not implemented yet**; selecting it disables Backend calling. All current calls and bookings are simulations.

### Configure an LLM for Backend calls

Choose one of the following options. Finish any active call before changing the provider or call engine.

**Option A: OpenAI API or Claude API**

1. Open **Settings → LLM agent**.
2. Select **Codex / OpenAI API** or **Claude API**.
3. Select or enter a model ID available to your provider account. Choose a supported **Reasoning effort**, or leave **Provider default**.
4. Under that provider's **API key** control, choose **Add key**, then enter your own key in the password field.
5. Click **Save LLM agent**.

API keys are encrypted in server-side SQLite and are not returned to the UI or persisted in browser storage. The encryption master key lives in a separate Docker volume. Keep keys out of Git, screenshots and shared messages. Provider API usage is billed separately; the app's estimated call budget does not cap actual model-token charges.

**Option B: Codex CLI with your ChatGPT login**

Build the optional image, which includes Codex CLI:

```sh
docker compose -f compose.yaml -f compose.codex.yaml build zeus-llama
```

If you already have a file-based Codex login on your computer, copy it into the private Docker login volume:

```sh
sh scripts/setup-codex-login.sh
```

If no saved login file exists, or your login is stored only in the OS keyring, sign in inside Docker instead:

```sh
docker compose -f compose.yaml -f compose.codex.yaml run --rm --no-deps zeus-llama codex login --device-auth
```

Follow the device-login instructions, then start the stack with the same override:

```sh
docker compose -f compose.yaml -f compose.codex.yaml up -d --wait
```

Open **Settings → LLM agent**, select **Codex CLI · ChatGPT login**, choose a model or leave the CLI default, and click **Save LLM agent**. Each developer uses their own login. The base image does not include Codex CLI; selecting it in Settings alone does not install or authenticate it. Continue using both Compose files for later builds and restarts.

For either option, select **Settings → Calling → Backend**, keep **Call engine → Mock service**, expand **Provider readiness**, and click **Check readiness again**. The mock transport and dialogue agent must be ready before a reviewed mock call can start. Readiness does not send a paid model request or prove that your account can access the chosen model.

### Prepare and run a conversation

1. In **Settings → Personal details**, enter the name and callback number Zeus may share, then save. These are your details; the destination contact identifies the business you want to call. You can edit or withhold shareable details for each request.
2. Open **Contacts** to save a business name, phone number and timezone, or enter the destination directly on Home. Use synthetic details for local testing. Mock calls never dial the supplied phone number.
3. On **Home**, choose **Conversation template** and **Conversation language**, enter your goal in English, and select the destination. For example: “Book a haircut tomorrow between 14:00 and 18:00, up to 30 EUR.” Supported conversation languages are Spanish, Russian, English and Polish.
4. Click **Prepare the plan**. If more details are needed, complete the **Request** form. Use **Enter details manually** to open that form directly. Check the booking name, future dates, business timezone, maximum service price, authority boundaries, shareable contact details and call limits. Complete any template-specific fields.
5. Review the **Zeus will…** card, then click **Call**. Preparing or reviewing a plan does not start a call. If Backend normalizes or changes the plan, review it again before calling.
6. For Backend mock calls, open [the operator](http://localhost:8080/), select the ringing call, and click **Answer call**. Act as the business: type a response, select the recognition language if needed, and click **Send caller utterance**. Leave **Partial prompt test** unchecked so the reply is final and the agent can process it. You do not need to create a second call in the operator.
7. Read the agent's replies and English translations in the Zeus Llama call window. You can continue by typing further business replies in the operator. Optional **Auto-play backend messages** and **Listen** use available browser/OS voices; typed replies work without a microphone.
8. If an offer requires your decision, return to Zeus Llama and approve or reject that exact offer before its deadline. Approval permits the next booking step; a separate confirmation from the business is still needed. Required prohibited fees cannot be overridden by approval.
9. Use **Stop call** to request hangup. Minimizing or closing the call popup keeps the call running; **View call** reopens it. Only one backend call may be active at a time.

### Review results and agreements

Open **Summary** for past calls, outcomes, conversation details, findings and next steps. **Repeat** loads the saved request for editing and review; it does not immediately dial. If a result is uncertain, check with the business before trying again.

Open **Agreements** for confirmed simulated appointments and answered requests. Switch between **List** and **Calendar**, filter entries, and select a date to see its agenda. Appointment times use the business timezone; other agreements use the call date in your browser's timezone. Confirmed appointments support calendar export from the result details.

**Delete entry** removes an agreement from Agreements and the calendar after confirmation; the original call remains in Summary. Deleting an entry or conversation text does not cancel an appointment. Backend calls, contacts and server settings persist in SQLite. Browser Simulator history and mode preferences belong to the current browser and origin. Conversation text expires after 30 days by default; structured result metadata remains.

## Common setup problems

If readiness shows **Mock: ready** and **Dialogue: missing**, the relay is running but no LLM agent is configured. A plain `docker compose up` intentionally defaults to a disabled agent. For reviewed conversations, each developer must configure their own provider under **Settings → LLM agent**: select OpenAI/Claude API, a model and their API key, then save; or install the optional Codex image and initialize their own saved login using the setup above. Selecting Codex CLI in the base image cannot install it. A saved **Disabled** selection overrides Compose bootstrap values, so select and save the provider in Settings even after changing the Compose configuration. Choose **Backend**, keep **Call engine → Mock service**, check readiness again and answer the call at `http://localhost:8080/`. Browser Simulator needs no LLM and does not call the mock relay. See [troubleshooting missing dialogue](docs/docker-development.md#mock-is-ready-but-dialogue-is-missing).

- **The API key or model fails during a call:** verify your provider, account access, model ID and saved key. Configuration readiness does not test a live model response.
- **No call appears at port 8080:** check that Settings uses **Backend** and **Mock service**, then run `docker compose ps`. Simulator runs only in the browser and does not ring the relay.
- **Codex is unavailable:** build with `compose.codex.yaml`, initialize the Docker login, and select/save Codex CLI in Settings. A saved Disabled setting overrides the Compose bootstrap provider.
- **A port is already in use:** stop the older local stack or choose different published ports as described in the [Docker guide](docs/docker-development.md). Keep the same port configuration for subsequent commands.
- **You forgot the owner password:** follow [local account recovery](docs/docker-development.md#16-owner-login-and-sessions). The recovery command preserves calls, contacts and settings; deleting the database is unnecessary.
- **The page still shows the old UI after a source update:** rebuild `zeus-llama` and reload the page. Use the Codex override as well if that is your selected image.

## Stop, restart and update

For the default image, run commands from the repository root:

```sh
# Inspect recent application logs.
docker compose logs --tail=100 zeus-llama mock-relay

# Stop and remove containers while keeping saved data.
docker compose down

# Start again, or rebuild after updating your checkout.
docker compose up --build -d --wait
```

For Codex CLI installations, add `-f compose.yaml -f compose.codex.yaml` after `docker compose` in each command. Regular shutdown preserves the database, encryption key and Codex login volumes. Avoid `docker compose down -v` unless you intend to delete those volumes. A useful backup must preserve the database together with its encryption master key; treat login and secret-volume backups as credentials.

## Product and engineering documents

Read the documents in this order:

1. [Requirements](docs/requirements.md): personal-use scope, UI, booking rules, and acceptance criteria.
2. [Architecture](docs/architecture.md): implemented containers, modes/providers, conversation authority, persistence, secret storage, recovery, and remaining Twilio work.
3. [Technology stack](docs/tech-stack.md): installed tools, deployment volumes, checks, and current versus planned provider boundaries.
4. [Three-engineer delivery plan](docs/mvp-delivery-plan.md): workstreams, task ownership, shared interfaces, dependencies, and PoC/MVP completion criteria.
5. [Three-engineer integration agreement](docs/engineering-contract.md): scope boundaries, deliverables, independent development, handoffs, merge order, and joint acceptance of one app.
6. [Shared interfaces v1](docs/interfaces.md): technical reference for executable schemas, API routes, event/reconnect protocol, and dialogue/voice boundaries.
7. [Backend to UI message contract](docs/ui-message-contract.md): case-by-case HTTP/SSE rules, payload formats, JSON examples, and expected UI behavior.
8. [Twilio account and configuration runbook](docs/twilio-setup.md): account creation, paid/trial limits, Voice number, Spain permissions, credentials, ConversationRelay, callbacks, and connectivity checks for Engineer 2.
9. [Docker backend development](docs/docker-development.md): container startup, configuration, SQLite storage, implemented endpoints, and checks.
10. [Offline Twilio protocol mock](docs/twilio-mock.md): official-format REST/webhook/TwiML/WebSocket adapter tests and a Docker walkthrough.
11. [Mock ConversationRelay development service](mock-conversation-relay/README.md): standalone Docker emulator with an operator browser UI, SDK-compatible Calls subset, signed callbacks/relay handshakes, optional queued dialing, and Connect action continuation checks.

The shared contracts, TypeScript/Fastify backend, and scripted simulator are implemented. Simulator mode supports plan review, Start/Stop, approval decisions, persistent snapshots, replayable SSE, history, and conversation deletion without provider credentials or provider requests. A simple development UI can start manual conversations through the local mock service and display operator replies. These calls share SQLite attempts, transcripts, history, Stop, the active-call reservation, and replayable SSE with the scripted simulator; they carry no booking authority. The Zeus Llama booking/request UI is also present, with a standalone browser simulator and shared HTTP/SSE client. UI/backend HTTP/SSE integration is covered by automated browser tests; real calling adapters remain to be built; an optional dialogue/controller path now handles Spanish, Russian, English, and Polish appointment inquiries across 15 templates through the local mock. Completed conversation text and replay events expire automatically after 30 days by default; booking metadata remains in history. Optional explicit test rates provide persisted usage estimates and enforce per-call budgets; real provider charges remain unavailable. Readiness reports database/configuration health, local mock connectivity and enabled capabilities. Simulator mode is required; when the manual mock transport is enabled, its health probe must pass for overall readiness. No real phone calls can start.

The [dialogue library](packages/dialogue/README.md) provides booking policy, multilingual appointment templates, and Codex CLI, OpenAI Responses API, and Claude Messages API adapters. Choose **Settings → LLM agent** to select the provider, model and reasoning effort, and add, replace or delete server-side API keys. Keys are encrypted in SQLite; Docker keeps the encryption master key in a separate private volume. Changes apply to subsequent Backend calls without restarting and are blocked while a call is active. See [LLM settings and secret storage](docs/docker-development.md#18-llm-agent-settings-and-secret-storage) and [Codex login setup](docs/docker-development.md#17-dialogue-driven-local-mock-calls).

**Settings → Call engine** selects **Mock service** or **Twilio** for Backend calls. The choice persists on the server. Twilio is labelled **not implemented yet**: selecting it makes Backend calling unavailable, with no fallback to mock or scripted calls. Switch back to Mock service to use the configured local simulation transport. Finish any active call before changing the engine. Browser Simulator remains a separate scripted mode.

Choose **Conversation language** on Home or the detailed Request page before reviewing a call. The call popup shows the reviewed agent language. The opening introduces the caller as an AI assistant without mentioning the app name and includes the approved name from the plan when supplied. Availability follow-ups ask about the service and reviewed time windows without repeating the introduction. When the offer is within the reviewed constraints, the mock automatically reads it back, sends acceptance after a simulated playback receipt, and waits for a separate business confirmation. The result is labelled as a simulation; offers outside the plan still require approval. Contact replies in any of the four supported languages are retained and translated; they do not change the agent language or approved plan. Choose **Conversation template** for domain-specific fields and questions. Controlled replies have stable IDs and versioned translations stored in SQLite; transcripts retain the rendered text and an English translation. Multilingual dialogue requires **Settings → Backend**, the configured dialogue model, and the local mock relay. The browser and backend scripted simulators retain their existing examples; domain templates and other selected languages require the configured backend dialogue path.

The 15 templates are Haircut, Dentist, Doctor/clinic, Vet, Restaurant, Car service, Plumber, Electrician, Home cleaning, Bank branch, Library, Government office, Legal consultation, Language school, and Parcel collection. They arrange appointments/reservations or information visits within the reviewed scope. See the [profile requirements and limits](packages/dialogue/README.md#conversation-templates).

See [the web UI guide](apps/web/README.md) for its workflow and current integration limits.

## Development and operational details

Read [AGENTS.md](AGENTS.md) before making changes. It contains the working instructions for Codex and the project's Git conventions.

The private API is published at `127.0.0.1:3000`; the separate callback listener at `127.0.0.1:3001` accepts development mock WebSocket upgrades at `/ws/voice` and signed progress callbacks at `/callbacks/mock/status/:id` when the development/mock gates are enabled. Production provider callbacks remain unavailable. SQLite persists in the `callmate-data` Docker volume.

The root `compose.yaml` starts exactly two services by default: `zeus-llama` (one Node.js process serving the API and built web UI) and `mock-relay`. It waits for dependency health checks. No `.env` file or host Node.js is required. Open:

- [Zeus Llama](http://localhost:3000/) — main app.
- [Mock relay operator](http://localhost:8080/) — answer simulated calls.
- [Technical console](http://localhost:3000/console/) — manual transport checks on the same app port.

Run `docker compose logs -f` for all logs and `docker compose down` to stop the stack while preserving SQLite. The browser simulator remains the default; dialogue-driven backend calls need the optional engine setup below. Services communicate through Docker DNS (`zeus-llama` and `mock-relay`); only browser-facing URLs use localhost. Set `CALLMATE_API_PORT` to change the shared app/API port and `CALLMATE_MOCK_PORT` for the operator. `CALLMATE_CALLBACK_PORT` remains the separate transport listener inside the same app container.

For frontend development only, `docker compose --profile dev up --build -d --wait` additionally starts Vite at `http://localhost:5173`, proxying `/api` to Zeus Llama. The normal stack serves compiled, hashed assets directly, with no Vite process. `VITE_MOCK` is a public build-time default; rebuild after changing it. The Codex override builds the UI with Backend selected by default.

When upgrading from the old `server`/`web` layout, finish active calls, then stop the old containers with `docker stop callmate-server-1 callmate-web-1` for the previous default project. Remove those stopped containers with `docker rm callmate-server-1 callmate-web-1`, then run the normal startup command. Use the actual names from `docker ps -a` if the project name differs. The project and volume names remain unchanged, preserving the existing SQLite and Codex volumes. Browser-only simulator history/preferences belong to each origin; old `localhost:5173` data stays available through the optional dev profile and is separate from database-backed history at port 3000.

If the old standalone mock stack is already running, stop it once with `docker compose -f mock-conversation-relay/compose.yaml stop mock-relay` before starting the combined stack. This frees port 8080; relay sessions are temporary, so finish active calls first. Existing backend data stays in the same `callmate-data` volume. Keep any existing Codex override selected to retain that engine and its login volume.

Open [the technical console](http://localhost:3000/console/), create/sign in to your owner account, enter an initial message, choose Spanish, Russian, English, or Polish, and click **Start conversation**. Click **Open operator window**, answer the ringing call, and type a reply in the mock service. Your initial message appears in the operator transcript; click **Listen** beside it to hear it using a browser/OS voice. Enable **Auto-play backend messages** before answering for automatic playback. The operator's reply appears in the backend UI's response field. **Stop conversation** hangs up the call. Refreshing the page or restarting the backend restores persisted conversation text. Graceful shutdown attempts to hang up active mock calls. After a crash, the backend reconciles stored CallSid/session IDs and ends orphaned mock calls without redialing or replaying text; unresolved calls retain their active reservation. Duplicate, delayed and out-of-order progress callbacks cannot reopen completed calls. Backend-started calls enforce one active slot, idempotent Start/Stop, a duration limit covering preflight/dialing, and a caller-silence deadline; Stop is available while Start is waiting. See the [recovery rules](docs/docker-development.md#10-persistent-correlation-and-recovery), [event handling rules](docs/docker-development.md#11-reliable-mock-status-callbacks), [call controls](docs/docker-development.md#12-call-controls-and-limits), [automatic retention](docs/docker-development.md#13-automatic-conversation-retention), [test-rate usage budgets](docs/docker-development.md#14-test-rate-usage-and-budgets), and [readiness diagnostics](docs/docker-development.md#15-readiness-diagnostics).

You can also create a call directly in [the relay operator UI](http://localhost:8080/) using the default backend URL. Those manual calls receive a development greeting and scripted echo replies; `/end` exercises backend hangup. Backend-started console calls create persisted manual attempts accessible through the shared API/SSE; directly created operator calls remain ephemeral echo checks. Neither path uses AI or makes booking decisions. The root Compose defaults enable the handler with `NODE_ENV=development`, `TELEPHONY_PROVIDER=mock`, and `CALLMATE_MODE=simulator`. See the [relay setup and limits](docs/docker-development.md#8-manual-conversationrelay-development-transport).

Run type checking and offline tests inside a disposable container:

```sh
docker compose --profile checks run --build --rm checks
```

Use `docker compose logs -f zeus-llama` for logs and `docker compose down` to stop/remove containers while preserving the database volume. See the [Docker guide](docs/docker-development.md) for configuration and endpoint examples.

Follow the [simulator walkthrough](docs/docker-development.md#7-run-a-simulated-call) to create a request, watch SSE, and exercise approvals or failures. Select scenarios with `CALLMATE_SIMULATOR_SCENARIO`; the default is `within_plan`.

An independent [Twilio protocol harness](docs/twilio-mock.md) uses the official SDK and real local HTTP/WebSocket traffic to test provider formats. It is separate from the API/SSE simulator and does not enable live calling. Run its offline walkthrough inside Docker:

```sh
docker compose --profile checks run --build --rm checks npm run demo:twilio-mock --workspace @callmate/server
```

The web workspace is included in the Docker build, type checking, and unit tests. To run the web UI and its database-backed address book in Docker:

```sh
docker compose up --build -d --wait
```

Open [Zeus Llama](http://localhost:3000/) and create the single owner account on first use (username and a 12–128 character password). Later visits require sign-in; **Sign out** is above the navigation. Login also protects the technical console at `/console/`, including simulator mode. The account and 12-hour sessions persist in SQLite. There are no default credentials, public registration, or cloud identity services. See [authentication and recovery](docs/docker-development.md#16-owner-login-and-sessions). The **Contacts** button opens the address book: create, search, edit, or delete contacts with a name, phone number, and IANA timezone (Europe/Madrid by default), plus optional tone preferences and notes. Contacts persist in the backend SQLite volume and are available in the Home/Request destination picker, including when calls use the browser simulator. Previous browser-only contacts can be explicitly imported from Contacts. Editing or deleting a contact preserves values already copied into requests and history.

Calls default to the browser simulator; contacts require the backend in both call modes. The technical console is at `/console/` on the same app port. Select **Settings → Backend** for server-managed calls. Reviewed mock calls require a ready dialogue engine; they never silently fall back to scripted results. To use your existing Codex login in Docker, follow the [Codex setup](docs/docker-development.md#17-dialogue-driven-local-mock-calls). Optional dialogue mode handles Spanish, Russian, English, and Polish appointment inquiries across 15 templates through the mock. Call budgets follow the backend settings currency (USD or EUR); service prices remain EUR. Changing budget currency requires another plan review and explicit re-entry of edited amounts. Manual-call history belongs in the console.

Starting a call opens a popup with the agent's phrases, the other side's replies, translations, and recorded agent actions/approval reasons. Stop and exact-offer approval controls are available there. Minimize it to use the rest of the app; **View call** reopens the same conversation without dialing again. The finished conversation and result remain visible until you close the popup or open Summary. **Call again** starts a new attempt with the same reviewed request after the call ends. If the backend adjusts the plan, review the updated details before calling.

To run the dialogue library's offline evaluation in Docker:

```sh
docker compose --profile checks run --build --rm checks npm run evaluate --workspace @callmate/dialogue
```

The [dialogue guide](packages/dialogue/README.md) describes standalone model examples. Default app startup and offline checks do not run Codex, send model requests, or enable real calls. Enabling the server dialogue agent sends call context through Codex CLI with your saved ChatGPT login, OpenAI API, or Claude API as selected in Settings; see the setup guide above.

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
