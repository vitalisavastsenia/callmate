# Docker backend development

The backend uses Node.js 24, TypeScript, Fastify, and SQLite via `better-sqlite3`. Docker builds the shared contracts and backend and runs the server; the host needs Docker Desktop/Engine and Compose, without Node.js or a local database server.

For provider-format checks, use the separate [offline Twilio protocol harness](twilio-mock.md). It exchanges official-format REST, signed callbacks, TwiML, and ConversationRelay messages inside the checks container; the API/SSE simulator remains the application walkthrough.

## 1. Start and inspect

From the repository root, with the Docker engine running:

```sh
docker compose up --build -d --wait server
docker compose ps
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/api/v1/readiness
docker compose logs -f server
```

The image uses a build stage with development dependencies/compilers and a separate runtime stage without those tools. The server runs as the unprivileged `node` user with a read-only image filesystem. A writable SQLite volume and temporary `/tmp` filesystem are mounted separately.

The Docker health check tests `/health`. Healthy means the process and SQLite are available. `/api/v1/readiness` reports `ready: true` in simulator mode with fake telephony, scripted dialogue, and simulated text playback (`voiceEngine: null`). In live mode it reports `ready: false`; live Start returns `503 PROVIDER_NOT_READY`. Switching to `live` never falls back to a simulated or real call.

## 2. Configuration

Defaults work without `.env`. For overrides, copy `.env.example` to ignored `.env` and edit it, then recreate the container with the startup command. Compose injects only the explicitly listed settings; it does not forward the whole host environment or `.env` file.

| Setting | Default | Rule |
| --- | --- | --- |
| `CALLMATE_MODE` | `simulator` | `simulator` is ready without credentials; `live` remains unavailable. |
| `NODE_ENV` | `development` in Compose; `production` in standalone image | Only `development` or `test` permits the unsigned mock relay. |
| `TELEPHONY_PROVIDER` | `mock` in Compose; `fake` without Compose | `mock` enables the development relay gate; `fake` disables it. The automatic API/SSE simulator continues to use fake telephony. Neither choice enables live calls. |
| `CALLMATE_MOCK_API_BASE` | `http://host.docker.internal:8080` | Backend-to-emulator HTTP origin. Local hosts only, no credentials/query/path. |
| `CALLMATE_MOCK_OPERATOR_ORIGIN` | `http://localhost:8080` | Browser-facing operator origin; change alongside the emulator's published port. |
| `CALLMATE_MOCK_RELAY_URL` | `ws://host.docker.internal:3001/ws/voice` | Emulator-to-backend WS destination; Compose follows `CALLMATE_CALLBACK_PORT` unless explicitly overridden. |
| `MOCK_ACCOUNT_SID` | `AC` + 32 zeroes | Synthetic account SID, matching the emulator. |
| `MOCK_API_USERNAME`, `MOCK_API_PASSWORD` | `mock`, `mock-local-only` | Synthetic local Calls credentials, matching the emulator. Never use real provider credentials. |
| `CALLMATE_API_PORT` | `3000` | Integer 1–65535; same port inside the container and on host loopback. |
| `CALLMATE_CALLBACK_PORT` | `3001` | Integer 1–65535; different from the API port. |
| `CALLMATE_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug`. |
| `CALLMATE_SIMULATOR_SCENARIO` | `within_plan` | Shared scenario identifier from the table below; stored on each attempt. |
| `CALLMATE_SIMULATOR_STEP_MS` | `750` | Integer 50–5000; delay between scripted transitions. |
| `CALLMATE_SIMULATOR_APPROVAL_SECONDS` | `30` | Integer 1–120; approval expiry, bounded by the approved call duration. |
| `CALLMATE_DATA_DIR` | `/data` | Set by Compose to the volume mount; standalone image configuration requires an absolute non-root writable app directory. |

Twilio and LLM credentials are not needed or consumed in this step. Provider configuration/Compose injection belongs to the later adapters. No secrets are built into the image: `.dockerignore` permits only workspace manifests, source, migrations, and offline tests; environment files, host dependencies, build artifacts, Git history, docs, and local data stay outside the build context.

Invalid configuration fails startup. Startup/error diagnostics deliberately omit supplied values, filesystem paths, provider tokens, raw request URLs/bodies/headers, and exception details. Request logs contain only a generated request ID, method, and status. Do not add arbitrary transcript/config objects to logs in future adapters.

## 3. Listener and route boundaries

Both Fastify listeners bind `0.0.0.0` **inside the container** so Docker forwarding can reach them. Compose publishes each port on host `127.0.0.1` only. Do not change the host binding to a public interface.

| Listener | Implemented routes |
| --- | --- |
| Private API, default host port 3000 | `GET /health`, the development UI at `/`, its `/console/` assets and `/api/dev/conversations` controls, plus all [shared HTTP/SSE routes](interfaces.md#4-private-http-api) operating on persisted simulator attempts. |
| Callback listener, default host port 3001 | Development-only WS upgrade `/ws/voice`, gated by simulator mode, development/test environment, mock provider, and `X-CallMate-Mock: true`. Ordinary HTTP and production provider callback routes return 404. |

Settings use the existing shared schemas. Example update:

```sh
curl --request PUT http://127.0.0.1:3000/api/v1/settings \
  --header 'Content-Type: application/json' \
  --data '{"defaultCallLimits":{"maxDurationSeconds":300,"maxEstimatedCost":{"amountMinor":200,"currency":"USD"}},"transcriptRetentionDays":14}'
```

Private requests require a recognized loopback Host and, when present, a same-app Origin. Cross-site browser requests are rejected. POST/PUT commands require JSON; DELETE conversation requests have no body. Use a same-origin UI or a future development proxy; cross-origin CORS access is not enabled. Error bodies use `ApiErrorSchema`; validation errors do not echo supplied values. Settings cannot include provider credentials.

No production Twilio callback/WSS route is active until signature validation and durable session correlation exist. Never tunnel the unsigned development mock relay. A future production host tunnel must forward only port 3001, never the private API, and must disable mock mode.

## 4. SQLite persistence and migrations

On startup, the server creates `/data/callmate.sqlite`, enables WAL and foreign keys, and applies numbered SQL migrations from `apps/server/migrations/`. `schema_migrations` records each version, filename, checksum, and application time. Applied migrations are immutable; append a new numbered file for changes. Missing, edited, duplicate, or unknown applied versions fail startup. Migration SQL and version records are committed in one transaction.

The initial migration creates and seeds application settings: a 300-second maximum call duration, USD 2.00 estimated call-cost limit, and 30-day transcript retention. Migration 002 adds review plans, call snapshots, internal script state, event replay, and idempotency records, plus a database-enforced single active-call reservation. Simulator duration limits are enforced; provider caps and automatic retention processing remain future work. The volume directory has mode 0700 and database file mode 0600; SQLite itself is not encrypted.

Snapshots and their event batches commit in one transaction. Start and approval UUID idempotency keys are persisted globally: retry the same endpoint/body/key to retrieve the same attempt's current snapshot. Reusing a key for a different command returns `409 IDEMPOTENCY_CONFLICT`. A new Start key is a new deliberate command, never a transport retry.

On restart, interrupted simulator attempts are finalized without resuming a script or dialing. Before simulated acceptance they become `not_booked/technical_failure`; after acceptance they become `uncertain/provider_state_unknown`. Existing confirmed results are preserved. Re-fetch the attempt and resume SSE to observe that recovery; retrying Start with the old key still returns that attempt.

`docker compose down` preserves the named data volume. Ordinary builds and checks do not delete it. Do not run two server containers against the same volume or mount a host repository directory over `/data`.

## 5. Build and checks inside Docker

```sh
docker compose build server
docker compose --profile checks run --build --rm checks
```

The checks service uses the build image and runs `npm run typecheck` and `npm test` entirely in its container with external networking disabled. The root workspace scripts build the contracts before consumers and run both contract and server checks. Server tests use temporary databases and internal loopback HTTP connections inside the disposable checks container; they do not mount the live data volume, publish ports, make phone calls, or contact model providers.

Checks cover browser Start/Stop, refresh recovery and safe text rendering, mock call creation/correlation/replies, configuration, migrations/transaction rollback, storage permissions, schemas, local-origin controls, listener separation, log/error redaction, scripted outcomes, approval/version/expiry handling, idempotency, Stop with a late model result, duration caps, restart recovery, history/deletion, and real HTTP/SSE replay/live/reset/shutdown.

For source edits, rerun the startup command with `--build`; this scaffold uses image rebuilds rather than host `node_modules` or a bind-mounted development server. To update dependency lock metadata without installing on the host, a maintainer can run:

```sh
docker run --rm \
  --mount "type=bind,source=$PWD,target=/workspace" \
  --workdir /workspace node:24-bookworm-slim \
  npm install --package-lock-only --ignore-scripts
```

This updates `package-lock.json` through the mounted workspace; actual dependency installation and native compilation happen during the Docker build. Never copy a host `node_modules` tree into the image.

## 6. Stop

```sh
docker compose stop server
```

Compose forwards SIGTERM; the application closes both HTTP listeners before closing SQLite. A failed second listener startup also closes the first listener and database. Use `docker compose down` when you also want to remove the stopped containers/network while retaining data.

## 7. Run a simulated call

Start the default scenario:

```sh
CALLMATE_MODE=simulator docker compose up --build -d --wait server
```

The following example runs its client inside the server container too. It creates a future appointment window in Europe/Madrid, reviews a synthetic request, then explicitly starts it. The example phone is never dialed.

```sh
docker compose exec -T server node --input-type=module <<'JS'
import { randomUUID } from 'node:crypto';
const base = `http://127.0.0.1:${process.env.CALLMATE_API_PORT || 3000}`;
const zoned = (date) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((value) => value.type === type).value;
  return { localDate: `${part('year')}-${part('month')}-${part('day')}`,
    localTime: `${part('hour')}:${part('minute')}`, timeZone: 'Europe/Madrid', instant: date.toISOString() };
};
const start = new Date(Date.now() + 7 * 86400000);
start.setUTCHours(16, 0, 0, 0);
const request = {
  business: { name: 'Example barbershop', phone: '+12025550123' },
  service: 'Haircut', bookingName: 'Alex Example',
  availability: [{ start: zoned(start), end: zoned(new Date(+start + 7200000)) }],
  pricePolicy: { maximum: { amountMinor: 3000, currency: 'EUR' }, allowUnknownPrice: false },
  bookingAuthority: 'within_constraints', shareableContact: { phone: null, email: null },
  callLimits: { maxDurationSeconds: 300, maxEstimatedCost: { amountMinor: 200, currency: 'USD' } },
};
const post = async (path, body, headers = {}) => {
  const response = await fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result;
};
const { plan } = await post('/api/v1/plans', request);
console.log('Reviewed synthetic plan:', plan.id, plan.version);
const key = randomUUID(); // Retain this key/body if retrying this same Start.
const { call } = await post('/api/v1/calls', {
  planId: plan.id, planVersion: plan.version, mode: 'simulator',
}, { 'Idempotency-Key': key });
console.log('Attempt:', call.id, 'Start key:', key);
JS
```

Replace `ATTEMPT_ID` below with the printed UUID:

```sh
curl http://127.0.0.1:3000/api/v1/calls/ATTEMPT_ID
curl -N --header 'Last-Event-ID: 0' http://127.0.0.1:3000/api/v1/calls/ATTEMPT_ID/events
```

SSE sends numbered `event: callmate` frames containing validated domain events, replays events after the supplied cursor, and then stays open for live updates. Heartbeats are unnumbered comments. A removed/future replay range sends unnumbered `event: reset` with `{"reason":"snapshot_required"}` and closes. Fetch a snapshot and reconnect using its `lastEventSequence`; reconnecting never starts a new attempt. Slow consumers are disconnected rather than accumulating unbounded buffers.

Stop is repeatable and acknowledges `ending` before the fake provider ends the call:

```sh
curl --request POST http://127.0.0.1:3000/api/v1/calls/ATTEMPT_ID/stop \
  --header 'Content-Type: application/json' --data '{}'
```

To select a different script, set `CALLMATE_SIMULATOR_SCENARIO` in `.env` or prefix the startup command, for example `CALLMATE_MODE=simulator CALLMATE_SIMULATOR_SCENARIO=approval_required docker compose up --build -d --wait server`. Recreating the server interrupts any active simulation; changing configuration never changes an existing attempt's stored scenario.

| Scenario | Expected behavior |
| --- | --- |
| `within_plan` | Offer at the first approved window's start, at the maximum service price (or €30 when no maximum); simulated authorized acceptance, explicit business confirmation, then end. `ask_before_accepting` still requires approval. |
| `no_availability` | Business declines availability; `not_booked/no_availability`. |
| `approval_required` | Price €5 above the reviewed maximum; exact-offer approval required when a finite maximum is set. Rejection/expiry ends without acceptance. |
| `changed_offer` | Initial alternative, followed by a second offer version with another €5 increase. Invalidate pending or granted-but-unspoken old permission; require the new offer's approval. Use a finite price maximum. |
| `disconnect` | Disconnect after simulated acceptance, before confirmation; uncertain result. |
| `pending_reply` | Business text arrives but the fake model remains pending. Stop cancels it; otherwise the approved duration limit ends the attempt without booking. |
| `busy`, `no_answer` | Corresponding telephone and non-booking results. |
| `provider_failure` | Scripted failure before connection; error event and `not_booked/technical_failure`. |

Approvals use the existing [message contract](ui-message-contract.md): retrieve `pendingApproval`, send its exact approval/plan/offer references and `approve` or `reject` to the approvals endpoint, with a new UUID `Idempotency-Key`. Never approve by supplying a replacement offer. No acceptance is played before a valid grant, and a grant is checked again immediately before playback. Approval is not business confirmation. Stop near acceptance preserves uncertainty; an already confirmed result is preserved.

History and terminal conversation deletion use the shared routes. Deletion clears Spanish/English transcript messages and old replay payloads, emits `conversation.deleted` to connected clients, and preserves booking metadata and idempotency tombstones. `transcriptRetentionDays` is stored but automatic retention scheduling remains future work.

The fake adapters implement the shared telephony/dialogue/text-voice ports. Their behavior is scripted, including offer extraction, Spanish replies, translations, and confirmation evidence; they do not validate arbitrary real conversations. Usage is marked unavailable, with no fabricated provider charges. No UI, audio generation, Twilio/LLM connectivity, real booking, or live recovery guarantee is delivered by this simulator.

## 8. Manual ConversationRelay development transport

The existing backend's callback listener accepts the emulator's outgoing WebSocket at `ws://host.docker.internal:3001/ws/voice`. Start/rebuild the root backend and the standalone emulator as described in the [emulator README](../mock-conversation-relay/README.md#point-callmate-at-the-emulator). In its UI, create a call, answer it, and type a caller utterance. A successful answer displays a development greeting; final prompts receive two `text` frames whose concatenation preserves Unicode and whitespace. The reply is explicitly labelled as development echo, using Russian, Spanish, Polish, or English wording according to the prompt locale. Other locale tags preserve the original input with an English prefix. No translation or natural-language understanding is performed. `/end` returns an `end` message with string `handoffData` declaring `bookingStatus: "not_booked"`; the emulator then closes the socket. Ordinary Hang up closes the transport from the provider side.

The callback listener reuses the ConversationRelay parser. Direct operator-created calls without console correlation remain ephemeral scripted echo checks. Backend-started calls from section 9 correlate only to persisted `manual_mock` attempts; they never authorize an existing booking attempt. Manual calls share the call controller, database reservation, snapshots, history, Stop and SSE with the booking simulator. They do not issue booking playback permits, evaluate offers, translate text or invoke dialogue/policy modules. Production provider correlation, signature validation and automatic restart reconciliation remain separate work.

The upgrade is accepted only when all of these hold: `CALLMATE_MODE=simulator`, `NODE_ENV=development|test`, `TELEPHONY_PROVIDER=mock`, exact path `/ws/voice` without query parameters, and `X-CallMate-Mock: true`. Browser Origin and Fetch-Metadata headers are refused. The marker is not authentication; keep both services on host loopback, and never publish or tunnel this endpoint. Production/live/fake settings reject upgrades with 404; a missing marker or browser request is 403. Private API routes remain inaccessible on the callback listener. An ordinary HTTP GET is not a WebSocket upgrade and continues to return 404.

Each socket must send one valid `setup` first, within five seconds. Call/session IDs are independently checked; duplicate setup and active/recent identity reuse close 1008. The replay guard is process-local and bounded to the latest 200 call/session pairs; it is not durable provider correlation. There are at most five concurrent sockets. Partial prompts are buffered to 8,000 characters and produce no reply until `last=true`; a language change inside a partial utterance is rejected. Interrupt clears buffered caller fragments; the synchronous scripted adapter has no queued speech to cancel. DTMF is validated and accepted without booking side effects. Provider `error` closes 1011 without reflecting its description. Malformed/unsupported/binary input closes 1007; frames over 32KiB close 1009. Outgoing buffers are bounded, call duration is capped by the application setting at connection time, and shutdown terminates sockets before closing SQLite. No transcript, custom parameter, raw request URL or provider exception value is logged.

The root Docker checks exercise actual WebSocket connections to this handler, including language/streaming behavior, partial prompts, isolation, replay rejection, access gates, malformed input, end, and shutdown. To verify the full Docker path manually, create a Russian or Spanish call in the emulator, answer it, send text, inspect the streamed echo, and hang up. No Twilio or model credentials are required.


## 9. Simple backend conversation UI

Start both services using the commands in the root README, then open **http://localhost:3000/**:

1. Enter the initial message and choose its language (Spanish, Russian, English, or Polish).
2. Click **Start conversation**. The backend creates one ringing call via the emulator's Calls API using inline ConversationRelay TwiML.
3. Click **Open operator window**, then **Answer call** in the mock service at port 8080. The backend sends your initial message once, preserving Unicode and whitespace. Click **Listen** beside it in the operator transcript to hear the message, or enable **Auto-play backend messages** before answering. **Stop audio** cancels local playback; Voice and Volume are under **Speech & keypad**. Browser/OS voice availability determines audio support.
4. Type a reply in the operator UI and send it. Final caller prompts appear verbatim in the backend's read-only response field, refreshed once per second. Partial prompts wait for their final fragment.
5. Click **Stop conversation** in the backend UI to hang up. The replies remain visible. Refresh restores the latest conversation; closing the page does not hang up.

Console calls persist the operator's finalized replies rather than automatically echoing them. Directly created operator calls without console correlation retain section 8's greeting/echo behavior. This page has no AI or automatic response generation, translation, booking logic, or real phone service.

The browser talks only to the private backend. The backend talks to the local Calls façade and correlates the relay with an opaque, per-conversation token; the browser receives no credentials or token. `conversationId` plus this process-local token may attach only to a persisted manual mock attempt, never a booking attempt. Tokens and socket handles are never stored in SQLite or event payloads. The marker alone grants no booking authority. Synthetic `To`/`From` values are display-only.

Development-only JSON routes (separate from the shared v1 booking contracts):

| Method | Route | Body / result |
| --- | --- | --- |
| GET | `/api/dev/conversations` | `{conversation: latestOrNull}`; reconciles with mock call status. |
| POST | `/api/dev/conversations` | `{requestId: UUID, initialMessage: string, language: "es-ES" or "ru-RU" or "pl-PL" or "en-US"}` → 202 `{conversation}`. Message must contain non-whitespace text, up to 8,000 characters. |
| GET | `/api/dev/conversations/:id` | `{conversation}` or 404. |
| POST | `/api/dev/conversations/:id/stop` | `{}` → `{conversation}`. |

Each conversation exposes `id`, `initialMessage`, `language`, `status`, `callSid`, `operatorUrl`, `responses: [{text, language, at}]`, and safe `error` text. Status is `creating`, `ringing`, `connected`, `disconnected`, `completed`, `failed`, or `unknown`. Only `completed`/`failed` allow another Start. Completion describes the call, not a booking.

Repeated Start with the same request ID and body returns the same conversation without redial; changed input with the same ID returns 409. Another active conversation returns 409. Creation is never retried automatically. An ambiguous create remains `unknown` and blocks new calls: inspect/hang up any call in the operator UI; restarting the backend does not release the reservation. A disconnected relay remains reserved until the provider confirms a terminal state or Stop succeeds.

Storage uses the same SQLite `call_attempts`, `call_events` and idempotency-command tables as the scripted simulator. No new migration is needed because snapshots/internal state are versioned JSON inside existing tables. Each manual snapshot has `kind: "manual_mock"`, `mode: "simulator"`, `plan: null`, and the selected language. It cannot carry offers, approvals or a confirmed booking outcome. `GET /api/v1/calls/:id`, `POST /api/v1/calls/:id/stop`, history, conversation deletion and replayable SSE all support these attempts. Creation remains `POST /api/dev/conversations`; the standard plan/start endpoints still create scripted booking simulations. The console routes are compatibility projections, not a second store/controller.

The initial text is persisted as a `withheld` assistant message, updated to `generated` when submitted to the relay. This does not claim that audio played or was heard. Final business text preserves whitespace, Unicode and locale exactly, with no invented English translation. Up to 2,000 messages are persisted per attempt; reaching the limit stops the call. The simple console shows the latest 50 replies within 32,000 characters. Initial text is capped at 8,000 characters. Retention is manual until the separate automatic-retention task is implemented. Terminal conversation deletion clears both initial/reply text and old transcript events; idempotency uses a SHA-256 request digest so deleted text is not retained in command records.

A single database reservation covers both scripted and manual calls. Their idempotency keys also share one namespace. A background poll of the local Calls API (once per second) persists provider completion and publishes SSE even with no browser open; provider callbacks are not integrated here. An ambiguous create or failed hangup retains the reservation, and no create request is retried automatically. A relay disconnect becomes `reconciliation_required` until provider completion or an explicit Stop is confirmed. Manual completion means `not_booked`, never booking success.

Completed snapshots, text, history and idempotency survive backend restart. Graceful shutdown attempts to hang up active console calls. On startup, an unresolved manual attempt is marked `reconciliation_required` and keeps its reservation; relay tokens are not restored, sockets are not resumed, and calls are not redialed. The known call can be inspected/stopped through the local mock service and its terminal state observed by polling. Robust provider reconciliation and recovery for ambiguous creation remain the separate recovery task; restarting the backend does not silently clear an unknown call.

If Start reports that the service is unavailable, start the emulator and verify both configured mock origins/ports. If credentials or account SID differ, set the same synthetic values in both Compose projects. Container-to-host access uses `host.docker.internal` (with Linux host-gateway mapping); the backend sends a local Host header accepted by the emulator. If Answer fails, inspect the operator diagnostic and check the relay destination as described in section 8.
