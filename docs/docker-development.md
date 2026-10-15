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

The Docker health check tests `/health`, which reads the SQLite application tables without checking the mock service. `/api/v1/readiness` reports database/configuration checks, mock connectivity and per-capability enabled/ready flags. Overall readiness requires valid local prerequisites and simulator mode; it also requires a healthy mock when the manual transport is enabled. A mock outage can leave scripted calls ready while overall readiness is false. `voiceEngine` remains `null`; in live mode readiness is false and live Start returns `503 PROVIDER_NOT_READY`. Switching to `live` never falls back to a simulated or real call. See [readiness diagnostics](#15-readiness-diagnostics).

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
| `MOCK_AUTH_TOKEN` | `mock-auth-token-local-only` | Synthetic status-callback signing token; must match the standalone emulator. This does not enable a production verifier or WS signature validation. |
| `CALLMATE_API_PORT` | `3000` | Integer 1–65535; same port inside the container and on host loopback. |
| `CALLMATE_CALLBACK_PORT` | `3001` | Integer 1–65535; different from the API port. |
| `CALLMATE_SILENCE_TIMEOUT_SECONDS` | `60` | Integer 5–600; caller inactivity after connection. Frozen per new call; see section 12. |
| `CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE` | Unset | Optional integer 1–60000, USD cents per elapsed minute; empty disables pricing for new calls. Synthetic development rate only; see section 14. |
| `CALLMATE_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug`. |
| `CALLMATE_SIMULATOR_SCENARIO` | `within_plan` | Shared scenario identifier from the table below; stored on each attempt. |
| `CALLMATE_SIMULATOR_STEP_MS` | `750` | Integer 50–5000; delay between scripted transitions. |
| `CALLMATE_SIMULATOR_APPROVAL_SECONDS` | `30` | Integer 1–120; approval expiry, bounded by the approved call duration. |
| `CALLMATE_DATA_DIR` | `/data` | Set by Compose to the volume mount; standalone image configuration requires an absolute non-root writable app directory. |

Real Twilio and LLM credentials are not needed or consumed in this step. Provider configuration/Compose injection belongs to the later adapters. No secrets are built into the image: `.dockerignore` permits only workspace manifests, source, migrations, and offline tests; environment files, host dependencies, build artifacts, Git history, docs, and local data stay outside the build context.

Invalid configuration fails startup. Startup/error diagnostics deliberately omit supplied values, filesystem paths, provider tokens, raw request URLs/bodies/headers, and exception details. Request logs contain only a generated request ID, method, and status. Do not add arbitrary transcript/config objects to logs in future adapters.

## 3. Listener and route boundaries

Both Fastify listeners bind `0.0.0.0` **inside the container** so Docker forwarding can reach them. Compose publishes each port on host `127.0.0.1` only. Do not change the host binding to a public interface.

| Listener | Implemented routes |
| --- | --- |
| Private API, default host port 3000 | `GET /health`, the development UI at `/`, its `/console/` assets and `/api/dev/conversations` controls, plus all [shared HTTP/SSE routes](interfaces.md#4-private-http-api) operating on persisted simulator attempts. |
| Callback listener, default host port 3001 | Development-only WS upgrade `/ws/voice` and signed form POST `/callbacks/mock/status/:id`, gated by simulator mode, development/test environment, mock provider, and `X-CallMate-Mock: true`. Other HTTP and production provider callback routes return 404. See section 11 for callback authentication and ordering. |

Settings use the existing shared schemas. Example update:

```sh
curl --request PUT http://127.0.0.1:3000/api/v1/settings \
  --header 'Content-Type: application/json' \
  --data '{"defaultCallLimits":{"maxDurationSeconds":300,"maxEstimatedCost":{"amountMinor":200,"currency":"USD"}},"transcriptRetentionDays":14}'
```

The web UI at port 5173 includes **Contacts** for creating, editing, and deleting the backend address book. Start it with `docker compose --profile web up --build -d --wait server web`. Contacts use the private `/api/v1/contacts` CRUD/import endpoints in both Simulator and Live modes. See the [contact API contract](interfaces.md#4-private-http-api) for required fields and responses. No provider credentials or real calls are involved.

Private requests require a recognized loopback Host and, when present, a same-app Origin. Cross-site browser requests are rejected. POST/PUT commands require JSON; DELETE conversation requests have no body. Use a same-origin UI or a future development proxy; cross-origin CORS access is not enabled. Error bodies use `ApiErrorSchema`; validation errors do not echo supplied values. Settings cannot include provider credentials.

No production Twilio callback/WSS route is active until signature validation and durable session correlation exist. Never tunnel the unsigned development mock relay. A future production host tunnel must forward only port 3001, never the private API, and must disable mock mode.

## 4. SQLite persistence and migrations

On startup, the server creates `/data/callmate.sqlite`, enables WAL and foreign keys, and applies numbered SQL migrations from `apps/server/migrations/`. `schema_migrations` records each version, filename, checksum, and application time. Applied migrations are immutable; append a new numbered file for changes. Missing, edited, duplicate, or unknown applied versions fail startup. Migration SQL and version records are committed in one transaction.

The initial migration creates and seeds application settings: a 300-second maximum call duration, USD 2.00 estimated call-cost limit, and 30-day transcript retention. Migration 002 adds review plans, call snapshots, internal script state, event replay, and idempotency records, plus a database-enforced single active-call reservation. Migration 003 adds a stable completion timestamp and an index for automatic transcript retention. Backend duration limits and automatic retention are enforced; real-provider caps remain future work. The volume directory has mode 0700 and database file mode 0600; SQLite itself is not encrypted.

Snapshots and their event batches commit in one transaction. Start and approval UUID idempotency keys are persisted globally: retry the same endpoint/body/key to retrieve the same attempt's current snapshot. Reusing a key for a different command returns `409 IDEMPOTENCY_CONFLICT`. A new Start key is a new deliberate command, never a transport retry.

Migration 004 adds contacts with unique normalized phones, timezone, tone preferences, notes, and creation/update timestamps. It applies automatically on startup without deleting existing data. Contact updates/deletions leave saved request and history values intact. Contacts remain until explicitly deleted; transcript retention does not remove address-book records. They are personal data stored in the same unencrypted, locally restricted SQLite volume.

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

History and terminal conversation deletion use the shared routes. Deletion clears Spanish/English transcript messages and old replay payloads, emits `conversation.deleted` to connected clients, and preserves booking metadata and idempotency tombstones. `transcriptRetentionDays` controls automatic cleanup at startup, every minute, and after settings changes; see section 13.

The fake adapters implement the shared telephony/dialogue/text-voice ports. Their behavior is scripted, including offer extraction, Spanish replies, translations, and confirmation evidence; they do not validate arbitrary real conversations. Usage is unavailable unless an explicit test rate is configured; section 14 describes synthetic estimates and budget enforcement. Provider charges remain unavailable. No UI, audio generation, Twilio/LLM connectivity, real booking, or live recovery guarantee is delivered by this simulator.

## 8. Manual ConversationRelay development transport

The existing backend's callback listener accepts the emulator's outgoing WebSocket at `ws://host.docker.internal:3001/ws/voice`. Start/rebuild the root backend and the standalone emulator as described in the [emulator README](../mock-conversation-relay/README.md#point-callmate-at-the-emulator). In its UI, create a call, answer it, and type a caller utterance. A successful answer displays a development greeting; final prompts receive two `text` frames whose concatenation preserves Unicode and whitespace. The reply is explicitly labelled as development echo, using Russian, Spanish, Polish, or English wording according to the prompt locale. Other locale tags preserve the original input with an English prefix. No translation or natural-language understanding is performed. `/end` returns an `end` message with string `handoffData` declaring `bookingStatus: "not_booked"`; the emulator then closes the socket. Ordinary Hang up closes the transport from the provider side.

The callback listener reuses the ConversationRelay parser. Direct operator-created calls without console correlation remain ephemeral scripted echo checks. Backend-started calls from section 9 correlate only to persisted `manual_mock` attempts; they never authorize an existing booking attempt. Manual calls share the call controller, database reservation, snapshots, history, Stop and SSE with the booking simulator. They do not issue booking playback permits, evaluate offers, translate text or invoke dialogue/policy modules. Production provider correlation and signature validation remain separate work; section 10 describes implemented local mock recovery.

The upgrade is accepted only when all of these hold: `CALLMATE_MODE=simulator`, `NODE_ENV=development|test`, `TELEPHONY_PROVIDER=mock`, exact path `/ws/voice` without query parameters, and `X-CallMate-Mock: true`. Browser Origin and Fetch-Metadata headers are refused. The marker is not authentication; keep both services on host loopback, and never publish or tunnel this endpoint. Production/live/fake settings reject upgrades with 404; a missing marker or browser request is 403. Private API routes remain inaccessible on the callback listener. An ordinary HTTP GET is not a WebSocket upgrade and continues to return 404.

Each socket must send one valid `setup` first, within five seconds. Call/session IDs are independently checked; duplicate setup and active/recent identity reuse close 1008. The transport replay guard is process-local and bounded to the latest 200 call/session pairs. Backend-started calls additionally use the durable correlation in section 10; direct operator echo calls do not. There are at most five concurrent sockets. Partial prompts are buffered to 8,000 characters and produce no reply until `last=true`; a language change inside a partial utterance is rejected. Interrupt clears buffered caller fragments; the synchronous scripted adapter has no queued speech to cancel. DTMF is validated and accepted without booking side effects. Provider `error` closes 1011 without reflecting its description. Malformed/unsupported/binary input closes 1007; frames over 32KiB close 1009. Outgoing buffers are bounded, call duration is capped by the application setting at connection time, and shutdown terminates sockets before closing SQLite. No transcript, custom parameter, raw request URL or provider exception value is logged.

The root Docker checks exercise actual WebSocket connections to this handler, including language/streaming behavior, partial prompts, isolation, replay rejection, access gates, malformed input, end, and shutdown. To verify the full Docker path manually, create a Russian or Spanish call in the emulator, answer it, send text, inspect the streamed echo, and hang up. No Twilio or model credentials are required.


## 9. Simple backend conversation UI

Start both services using the commands in the root README, then open **http://localhost:3000/**:

1. Enter the initial message and choose its language (Spanish, Russian, English, or Polish).
2. Click **Start conversation**. The backend creates one ringing call via the emulator's Calls API using inline ConversationRelay TwiML.
3. Click **Open operator window**, then **Answer call** in the mock service at port 8080. The backend sends your initial message once, preserving Unicode and whitespace. Click **Listen** beside it in the operator transcript to hear the message, or enable **Auto-play backend messages** before answering. **Stop audio** cancels local playback; Voice and Volume are under **Speech & keypad**. Browser/OS voice availability determines audio support.
4. Type a reply in the operator UI and send it. Final caller prompts appear verbatim in the backend's read-only response field, refreshed once per second. Partial prompts wait for their final fragment.
5. Click **Stop conversation** in the backend UI to hang up. The replies remain visible. Refresh restores the latest conversation; closing the page does not hang up.

Console calls persist the operator's finalized replies rather than automatically echoing them. Directly created operator calls without console correlation retain section 8's greeting/echo behavior. This page has no AI or automatic response generation, translation, booking logic, or real phone service.

The browser talks only to the private backend. The backend talks to the local Calls façade and correlates the relay with an opaque, per-conversation token; the browser receives no credentials or token. `conversationId` plus this token may attach only to a persisted manual mock attempt, never a booking attempt. SQLite stores only its SHA-256 hash, alongside provider identity and CallSid/session IDs; raw tokens and socket handles are never stored in SQLite or event payloads. After restart, valid late setup can identify an orphan for hangup, but cannot resume speech. The marker alone grants no booking authority. Synthetic `To`/`From` values are display-only.

Development-only JSON routes (separate from the shared v1 booking contracts):

| Method | Route | Body / result |
| --- | --- | --- |
| GET | `/api/dev/conversations` | `{conversation: latestOrNull}`; reconciles with mock call status. |
| POST | `/api/dev/conversations` | `{requestId: UUID, initialMessage: string, language: "es-ES" or "ru-RU" or "pl-PL" or "en-US"}` → 202 `{conversation}`. Message must contain non-whitespace text, up to 8,000 characters. |
| GET | `/api/dev/conversations/:id` | `{conversation}` or 404. |
| POST | `/api/dev/conversations/:id/stop` | `{}` → `{conversation}`. |

Each conversation exposes `id`, `initialMessage`, `language`, `status`, `callSid`, `sessionId` (nullable until setup), `operatorUrl`, `responses: [{text, language, at}]`, and safe `error` text. Status is `creating`, `ringing`, `connected`, `disconnected`, `completed`, `failed`, or `unknown`. Only `completed`/`failed` allow another Start. Completion describes the call, not a booking.

Repeated Start with the same request ID and body returns the same conversation without redial; changed input with the same ID returns 409. Another active conversation returns 409. Creation is never retried automatically. An ambiguous create remains `unknown` and blocks new calls until correlated and confirmed ended. Restart does not release that reservation. A disconnected relay triggers orphan reconciliation/hangup and remains reserved until the provider confirms termination.

Storage uses the same SQLite `call_attempts`, `call_events` and idempotency-command tables as the scripted simulator. No new migration is needed because snapshots/internal state are versioned JSON inside existing tables. Each manual snapshot has `kind: "manual_mock"`, `mode: "simulator"`, `plan: null`, and the selected language. It cannot carry offers, approvals or a confirmed booking outcome. `GET /api/v1/calls/:id`, `POST /api/v1/calls/:id/stop`, history, conversation deletion and replayable SSE all support these attempts. Creation remains `POST /api/dev/conversations`; the standard plan/start endpoints still create scripted booking simulations. The console routes are compatibility projections, not a second store/controller.

The initial text is persisted as a `withheld` assistant message, updated to `generated` when submitted to the relay. This does not claim that audio played or was heard. Final business text preserves whitespace, Unicode and locale exactly, with no invented English translation. Up to 2,000 messages are persisted per attempt; reaching the limit stops the call. The simple console shows the latest 50 replies within 32,000 characters. Initial text is capped at 8,000 characters. Automatic retention applies to completed manual attempts as well as scripted calls; see section 13. Terminal conversation deletion clears both initial/reply text and old transcript events; idempotency uses a SHA-256 request digest so deleted text is not retained in command records.

A single database reservation covers both scripted and manual calls. Their idempotency keys also share one namespace. Signed mock progress callbacks persist lifecycle updates and publish SSE even with no browser open; the once-per-second Calls API poll remains a reconciliation fallback. Both use the same monotonic lifecycle rules. An ambiguous create or failed hangup retains the reservation, and no create request is retried automatically. A relay disconnect becomes `reconciliation_required` and triggers status reconciliation and orphan hangup; failed Stop requests are also retried in the background. Manual completion means `not_booked`, never booking success.

Completed snapshots, text, history and idempotency survive backend restart. Graceful shutdown attempts to hang up active console calls; crash recovery follows section 10.

## 10. Persistent correlation and recovery

Backend-started manual calls persist this internal correlation atomically with the attempt in SQLite's existing JSON storage (no SQL migration required): provider API origin/account, SHA-256 relay-token hash, CallSid, ConversationRelay session ID when received, creation phase, and whether recovery is required. These fields are runtime-validated when read/written. The development projection exposes the CallSid and nullable `sessionId`; provider identity and token hashes never appear in public snapshots/events. Raw correlation tokens are transmitted only to the configured local emulator, never saved in the backend database or logs.

Before any Calls create request, the backend commits `creation: submitted`. A record still marked `prepared` after a crash proves that no create request was sent, so recovery finalizes it as failed and frees the slot. The small interval between committing `submitted` and sending the request is deliberately treated as ambiguous. No recovery path submits another create request. Reusing the original Start UUID always returns its original attempt.

At startup, recovery runs once after the listeners bind, then checks unresolved calls once per second without needing a browser. Provider requests time out after 2.5 seconds, and overlapping polls and overlapping hangup requests for an attempt are coalesced. Status/hangup retries have no automatic expiry that could incorrectly free the slot.

| Evidence after restart or relay loss | Backend action |
| --- | --- |
| Known CallSid, matching stored API origin/account, provider reports terminal | Persist the terminal state/outcome and SSE events, then release the slot. Do not hang up again. |
| Known CallSid, matching identity, provider reports queued/ringing/in-progress | Verify resource SID/account/from/to; hang up the orphan through the Calls API. Persist `ended` only after confirmed termination, then release the slot. Recovery-initiated hangup records `not_booked/technical_failure`; explicit user Stop records `user_stopped`. |
| Submitted creation, no known CallSid | Retain `reconciliation_required` and the slot. A signed status callback can supply the CallSid, or a late relay setup with the persisted token hash and matching identity can supply the CallSid/session ID, for verified reconciliation/hangup. Send no greeting, consume no prompts, and never resume speech. |
| Provider unavailable, 404, malformed/mismatched resource, or hangup unconfirmed | Retain the reservation and a safe error; retry status/hangup. A missing record is not proof that a call ended. |
| Stored API origin/account differs, or legacy active record lacks correlation | Send no provider request. Keep the slot reserved for inspection against the original provider; do not bind an old call to a new account/service. Completed legacy records remain readable. |

Recovery always hangs up the provider before closing any surviving relay socket. Socket loss also triggers this policy; partial caller text is not restored and the initial message is never replayed. Existing persisted transcripts/history and SSE sequence numbers survive recovery. Manual completion never confirms a booking.

Limits: this implements recovery for the configured local mock Calls adapter, not real Twilio. Signed local status callbacks are implemented; real-provider callbacks and WS signature validation remain separate work. An ambiguous call with no CallSid and no subsequent signed status callback or authenticated setup cannot be identified automatically; there is no guess by phone number or automatic reservation override. Inspect the original operator page, and preserve the backend data volume while unresolved. Hanging up an unidentified call in the operator page alone cannot release the backend reservation. The emulator itself is in-memory: if it restarts and loses records, the backend's 404 remains unresolved rather than inventing completion.

The Docker checks include a separate backend process killed with SIGKILL, while the test provider remains running. They cover queued/ringing/connected and terminal calls, unavailable provider, failed hangup/retry, missing records, changed identities, lost create replies with late setup, pre-submission crashes, durable session IDs, preserved transcripts/events, and no redial/repeated greeting.

If Start reports that the service is unavailable, start the emulator and verify both configured mock origins/ports. If credentials or account SID differ, set the same synthetic values in both Compose projects. Container-to-host access uses `host.docker.internal` (with Linux host-gateway mapping); the backend sends a local Host header accepted by the emulator. If Answer fails, inspect the operator diagnostic and check the relay destination as described in section 8.


## 11. Reliable mock status callbacks

Backend-started manual calls automatically subscribe to `initiated`, `ringing`, `answered` and `completed` through the Calls API's repeated `StatusCallbackEvent` form fields. `StatusCallback` points to `/callbacks/mock/status/:attemptId` on the callback listener. Its HTTP origin is derived from `CALLMATE_MOCK_RELAY_URL` by replacing `ws:` with `http:`; the exact destination URL is persisted before submitting the call. No separate URL setting is needed for the current local Docker setup.

The emulator posts official-format `application/x-www-form-urlencoded` progress fields. An example body, before URL encoding:

```text
AccountSid=AC00000000000000000000000000000000
CallSid=CA11111111111111111111111111111111
From=+48000000000
To=+48111111111
CallStatus=in-progress
SequenceNumber=2
CallbackSource=call-progress-events
Timestamp=Thu, 15 Oct 2026 12:00:00 GMT
```

`answered` is a subscription name; its payload status is `in-progress`. Form-encode plus signs as `%2B`. The request needs the mock marker and `X-Twilio-Signature`, verified by the official Twilio SDK with the shared synthetic `MOCK_AUTH_TOKEN`. Verification uses the persisted destination URL and **all** form fields, including extra provider fields, before schema parsing. The request path/Host must match that URL; query additions, browser Origin/Fetch-Metadata, duplicate form keys, malformed sequence/timestamp, and wrong account/call/from/to are rejected. Bodies are capped at 16KiB and 50 fields. Private API routes do not accept these callbacks. Production/live/fake modes return 404. WS signature verification remains separate work, so the existing local-only transport restriction still applies.

SQLite stores a per-attempt callback sequence and highest provider progress alongside the existing correlation. Cursor, CallSid binding, snapshot and event batch commit atomically before the endpoint returns 204. Failed processing returns an error and rolls back the cursor as well, allowing the same event to be retried. Raw callback bodies, signatures and signing tokens are not persisted or logged. Existing active records without a callback URL continue using polling and relay correlation; they are not silently assigned a new callback destination. No database migration or UI contract change is required.

| Delivery | Result |
| --- | --- |
| Duplicate or lower/equal `SequenceNumber` | Return 204 with no public revision, transcript, SSE event or provider side effect. |
| Higher sequence with forward status | Advance the cursor and apply progress. Missing sequence numbers do not block processing. Order follows the sequence, not arrival time or timestamp. |
| Higher sequence with regressing status | Advance only the internal cursor; never move `connected` back to ringing/dialing. Later lower-sequence callbacks are still stale. Polling can reconcile a missed terminal state. |
| Progress during Stop/recovery | Record ordering/correlation, but preserve `ending` or `reconciliation_required`; do not resume output or cancel hangup. |
| Terminal status | Atomically finalize the call/outcome and release its reservation once. A terminal callback can correlate a lost create response. |
| Any event after a terminal result | Acknowledge valid retries with 204; preserve the first terminal state, outcome, revisions and messages, even if the retry has a higher sequence or conflicting terminal status. |
| Late REST/create response or relay event | Apply the same forward-only lifecycle guards. A stale response cannot reopen a finished call or affect a newer attempt. |

For example, delivery `in-progress/2 → ringing/1 → completed/3 → in-progress/100` produces only `connected → ended`. The delayed ringing and post-completion progress are acknowledged without UI events. Provider progress can mark a call connected before relay setup; the initial assistant message remains `withheld` until the actual relay submission and is never replayed by a callback.

Callback sequence is separate from UI SSE sequence. Internal cursor-only changes do not alter the public revision or emit SSE. Retrying after restart or after transcript deletion still respects the terminal tombstone; deleted text cannot be recreated. A late callback for an older attempt cannot change the current call's reservation. Provider termination and booking outcome remain separate; no callback confirms an appointment. A persisted hangup intent preserves `technical_failure` for interrupted orphan calls even when their completion callback races the hangup response; explicit Stop retains `user_stopped`.

The root Docker checks exercise signed HTTP traffic, concurrent duplicates, out-of-order progress, completion before the create response, delayed polls, Stop/recovery races, restart/deletion replay, invalid signatures/identities, and transaction rollback/retry. The standalone emulator sends callbacks once without automatic retries; retry/delay scenarios are injected by the backend tests. Missing callbacks remain recoverable through the local Calls poll. This implements the local mock path; real Twilio integration remains future work.


## 12. Call controls and limits

These controls apply to backend-created manual mock calls and the scripted simulator. Direct operator-created echo checks remain transport diagnostics outside persisted attempts and the shared call reservation. No real Twilio or dialogue integration is enabled.

- **One active call:** simulator and manual Start share the same SQLite transaction and unique active index. `creating`, dialing/ringing, connected, ending, and unresolved recovery all reserve the slot. A different Start returns `409 CALL_ALREADY_ACTIVE`. Only confirmed termination releases a submitted call's slot.
- **Idempotent Start:** the same manual `requestId` (or shared API `Idempotency-Key`) and identical input return the existing attempt, including after completion, restart or transcript deletion. Changed input or command reuse returns `409 IDEMPOTENCY_CONFLICT`. A timeout never causes automatic create/redial.
- **Idempotent Stop:** Stop records cancellation before awaiting a provider. Concurrent requests share one hangup operation. Repeated Stop after termination leaves the snapshot, events and provider untouched. Failed/unconfirmed hangups retain the slot and are reconciled in the background; retrying termination is safe and does not redial. The first stop reason is retained, so a later user Stop cannot relabel an already expired deadline.
- **Duration:** manual Start snapshots `defaultCallLimits.maxDurationSeconds` from `GET /api/v1/settings` (30–600 seconds, default 300). The deadline starts when the backend reserves the attempt, covering health preflight, submission, queue/ringing, and conversation. The simulator uses the duration in its approved plan. Changing settings does not extend or shorten a running call. The backend checks manual deadlines at least once per second while running and also before submission, progress application, relay setup, and caller input; an in-flight provider request does not postpone the local cancellation decision.
- **Silence:** `CALLMATE_SILENCE_TIMEOUT_SECONDS` defaults to 60 seconds (5–600). Manual Start freezes this value; the first observed `in-progress` response/callback or validated relay setup starts the deadline. Nonblank, validated prompt fragments (including partial speech), DTMF, and nonblank interruption text reset it. Empty/whitespace frames, polls, repeated status callbacks and browser activity do not. Inputs at or after a deadline cannot revive the call or add transcript text. A connected call with missing relay setup also times out. The simulator resets silence on its scripted conversation turns and cancels stalled dialogue work; it has no real audio activity.
- **Cancellation while dialing:** Stop before submission finishes locally and sends no create. If creation is already submitted but its CallSid is unknown, keep `ending`/`reconciliation_required` and the slot; cancel as soon as a correlated response, callback or relay setup supplies the SID. Never replay the initial text on that path. Verified queued/ringing calls receive official-format `Status=canceled`; connected calls receive `Status=completed`. If Answer races cancellation and the provider rejects `canceled`, reconciliation reads the current state and retries a connected hangup. No callback is required to confirm a queued cancellation: its terminal REST response suffices.

Manual calls persist duration/silence deadlines and the first stop reason with the existing internal correlation data. Activity-only updates do not emit SSE or change the public revision. Restart keeps the existing orphan policy: reconcile and terminate, never resume a conversation, reset its deadlines, or redial. Legacy records without controls still follow that recovery policy. A crash or unreachable provider cannot guarantee remote termination; the reservation remains until a terminal result is confirmed. A provider-side maximum duration for real calls belongs to the later live adapter; the standalone emulator also retains its independent configured timeout.

Manual deadline expiry emits the existing `call.error` with a safe duration/silence message and `call.status=ending`. No booking result is claimed while hangup is unconfirmed. Confirmed termination emits `booking.updated` with `not_booked/technical_failure` and a summary naming the deadline, followed by the terminal call state. Explicit Stop reports `not_booked/user_stopped`. Existing callback ordering and immutable terminal-result rules still apply. No shared schema or database migration is needed.

The simple console enables Stop during the initial Start HTTP request. It preserves cancellation intent when Stop arrives before the backend has reserved the attempt, retries it after Start is acknowledged or the attempt is recovered by polling, and ignores stale Start results after a successful Stop. The console is not required for deadline enforcement.

The Docker checks cover frozen duration settings, preflight/submission races, simultaneous Stop requests, queued/ringing/connected cancellation, Answer races, deadline failure/restart, partial-speech/DTMF activity, empty frames and callbacks, missing/late relay setup, no-browser timer enforcement, and stalled simulator output. All tests use local mocks with synthetic credentials.


## 13. Automatic conversation retention

`transcriptRetentionDays` in `GET`/`PUT /api/v1/settings` controls conversation-text retention: default **30 days**, configurable from **1 to 365**. A day means 24 hours. An attempt expires when its completion time is at or before `current UTC time − retention days`. Age starts at confirmed call termination, not call creation, the last spoken message, or booking confirmation.

Cleanup runs before either HTTP listener opens, then every 60 seconds without a browser, and immediately after a successful settings write. Lowering the setting applies to existing completed calls; increasing it never restores deleted data. The worker selects expired IDs in batches of 100, purges each attempt in its own SQLite transaction, and finishes the backlog in that pass. While running, expiration is processed on the next pass; startup catches up after downtime.

Only terminal calls (`ended`, `busy`, `no_answer`, `failed`) are eligible. Active, ending, and `reconciliation_required` attempts retain their conversation data and active reservation regardless of age. Restart recovery first finalizes/reconciles interrupted calls as usual; a newly finalized call starts its retention age at that termination. Cleanup makes no provider requests or calls and does not release an unresolved reservation.

For each expired attempt, the existing deletion transaction:

1. Removes original/translated transcript messages, including the manual initial message and operator replies.
2. Deletes all old replay events, so transcript text cannot be recovered through SSE replay.
3. Sets `conversationData=deleted`, advances the snapshot revision and event sequence once, and stores one `conversation.deleted` event. A repeat pass or manual Delete is a no-op.
4. Preserves the structured plan, offer, booking outcome/summary, opaque confirmation/evidence message IDs, usage, creation/completion/confirmation timestamps, history ordering, provider correlation, and idempotency tombstones. Booking evidence is validated while text is retained; deletion does not invent new evidence or a new booking result.

Connected SSE clients at the previous final cursor receive `conversation.deleted`. A cursor older than the purge floor receives `reset/snapshot_required`; clients must clear cached conversation text and refetch. Future cursors also reset under the existing rules. History and GET continue to show the booking card with an empty transcript. The development projection now includes `conversationData`; polling clears replies and the old initial-message editor contents while preserving a newly written draft. Idempotent Start and late provider callbacks continue to return the deleted terminal attempt without recreating text or redialing.

Migration 003 persists the first terminal timestamp independently of later snapshot updates. Existing terminal rows use the first persisted terminal status event, falling back to the snapshot's `updatedAt` when that event is unavailable; active rows have no completion time. Later metadata changes, deletions and restarts do not extend this timestamp. Shared API/SSE schemas remain unchanged.

If a purge fails, that attempt's snapshot, events and replay floor roll back together. A startup failure prevents listeners from opening; a scheduled failure logs only a safe `RETENTION_FAILED` message and retries on the next minute. Previously committed purges remain deleted. Settings writes are saved before their cleanup pass; if that pass returns an error, the saved setting still applies and the periodic worker retries. Shutdown stops the worker before storage closes. Cleanup removes application data; it does not securely erase SQLite pages/WAL files, backups, provider records or copies already received by clients.

Docker checks cover exact expiry boundaries, completion versus update time, confirmed/uncertain/manual outcomes, active-call exclusion, migration/backfill, startup and periodic cleanup, settings changes, transaction rollback/retry, SSE deletion/reset, command and callback replay, UI clearing, and multiple batches with stable history pagination.


## 14. Test-rate usage and budgets

Usage remains `unavailable` by default. To exercise metering and budget stops without any billable service, set `CALLMATE_TEST_RATE_USD_MINOR_PER_MINUTE=60` in ignored `.env` and recreate the backend with `docker compose up --build -d --wait server`. This explicit rate means **60 USD cents per elapsed minute**, not a Twilio or model price. An empty/unset value disables pricing for new attempts; zero, fractional, negative and out-of-range rates fail startup. No pricing endpoint or provider billing request is made.

At Start, the backend captures the rate, its `elapsed-minute-v1` version, capture time and per-call USD budget. Scripted calls use the approved plan's `callLimits.maxEstimatedCost`; manual calls use the current settings' `defaultCallLimits.maxEstimatedCost`. Changing the rate or defaults cannot reprice an existing attempt. Existing attempts without a test meter stay unavailable even after rates are enabled. With a configured rate, a zero budget returns `409 BUDGET_EXCEEDED` before a call, idempotency record or provider request is created. With no rate, the backend cannot estimate spending and does not invent a zero cost or budget guarantee; duration and silence controls still apply.

The development meter deliberately counts **elapsed time from local attempt creation through first confirmed terminal state**, including preflight, dialing, silence, ending, ambiguous creation, recovery and downtime. It does not claim to measure connected audio or provider billable seconds. Cost in USD cents is `ceil(elapsedMs × rateMinorPerMinute / 60000)`, calculated cumulatively with exact integer arithmetic. Frequent samples never round each increment separately or double-count callbacks. A backwards clock cannot reduce recorded usage. Normal ticks sample elapsed time at second boundaries and lifecycle changes also measure usage; simulator samples wait for in-flight dialogue work unless the budget expires. Terminal usage freezes, including across duplicate callbacks, Start/Stop retries, restart and transcript deletion/retention.

The same snapshot/event transaction persists `usage`, its frozen `testUsage` meter and `usage.updated`. GET, history, Start retries and SSE replay expose this data; the development conversation projection now also includes `usage`. The existing JSON snapshot storage supports the optional meter, so no SQL migration is needed. If persistence fails, both meter and event roll back; the next successful sample computes the cumulative value from the original start.

Example `usage.updated` payload after 2 seconds at 60 cents/minute with a 2-cent budget:

```json
{
  "estimate": { "amountMinor": 2, "currency": "USD" },
  "settledTotal": null,
  "status": "estimated",
  "measuredAt": "2026-10-15T10:00:02.000Z",
  "testUsage": {
    "source": "test_rates",
    "rateVersion": "elapsed-minute-v1",
    "rateMinorPerMinute": 60,
    "currency": "USD",
    "rateCapturedAt": "2026-10-15T10:00:00.000Z",
    "elapsedMs": 2000,
    "budget": { "amountMinor": 2, "currency": "USD" }
  }
}
```

Budget expiry uses the unrounded accumulated value: `elapsedMs × rate >= budgetMinor × 60000`, not the rounded displayed cents. For example, 1 ms at 60 cents/minute displays 1 cent but does not exhaust a 1-cent budget until 1000 ms. Enforcement runs through the existing timers without a browser, at manual call-control boundaries and before simulator continuation/playback. A pending dialogue result cannot send acceptance after expiry. Expiry emits `call.error` with `BUDGET_EXCEEDED`, invalidates scripted work/approvals, and stops the call. Existing confirmed bookings survive; acceptance without confirmation remains uncertain. Manual attempts end as `not_booked/technical_failure`, with a test-budget explanation. A Stop that already won the race retains its original reason.

Before provider submission, manual expiry prevents Calls creation and safely releases the slot. During submission/queued/ringing/connected states, the existing cancellation/hangup/reconciliation logic applies. Unconfirmed hangup retains the active reservation and blocks output; recovery never redials. Metering continues until confirmed termination, and reports overruns honestly. Timer granularity (up to one second for the manual path), event-loop delays, elapsed downtime, integer-cent rounding and provider response/hangup delays can exceed the configured test budget. This is a local test spending control, not a hard provider billing ceiling or a daily/monthly spending policy.

Always label `testUsage.source=test_rates` as **Test-rate estimate**. `settledTotal` stays `null` and `status` stays `estimated`, even after completion. Unknown real Twilio, ConversationRelay and model charges must appear as unavailable; zero provider cost must never be inferred. This step adds no live provider pricing/reconciliation or dialogue usage adapter.

Docker checks cover opt-in validation, rounding/exact boundaries, zero-budget rejection, frozen rates/budgets, legacy records, preflight/submission cancellation, queued and connected stops, no-browser enforcement, failed hangup/overrun, delayed dialogue output, atomic persistence/retry, metadata preservation, duplicate callbacks, restart and deletion/retention.


## 15. Readiness diagnostics

`GET /api/v1/readiness` is a private, origin-checked, read-only diagnostic endpoint. It returns **HTTP 200 with `ReadinessSchema` even when dependencies fail**; inspect `ready`, individual `checks` and `capabilities`. Responses use `Cache-Control: no-store`. The callback listener does not expose this route. No calls, transcript reads, settings writes, redial or hangup are performed.

| Check | What it verifies | Failure/disabled behavior |
| --- | --- | --- |
| `storage` | SQLite can read `app_settings` and `call_attempts`. Migrations were validated at startup. | `failed` with a safe message if storage/table access fails. This is a read probe, not a write or disk-space guarantee. |
| `configuration` | Effective server configuration passes validation and stored settings pass `SettingsSchema`. | `failed` if invalid, or if settings cannot be validated because storage is unavailable. Malformed environment settings and migration failures still prevent startup. |
| `mock` | When enabled and local prerequisites pass, GET the configured local mock's `/healthz`; require 2xx JSON with `mock=true` and the expected service name. | `failed` on timeout, refusal, wrong identity, malformed/oversized response or redirect. `not_required` when the transport gate is off. Skip the probe when configuration/storage fails. |
| `telephony` | Scripted fake telephony is installed in simulator mode. | `missing` in live mode. This does not certify a real Twilio account. |
| `voice` | Local mock relay code is enabled and mock health is available. | `failed` when enabled prerequisites fail; `not_required` for scripted playback; `missing` in live mode. No WS/callback round trip is performed. |
| `dialogue` | Scripted dialogue is installed in simulator mode. | `missing` in live mode. No model/API request is made. |
| `tunnel` | Not needed for the local simulator/mock workflow. | `not_required` in simulator mode; `missing` in live mode because public connectivity is unverified. |

The mock transport gate requires all three: `CALLMATE_MODE=simulator`, `TELEPHONY_PROVIDER=mock` and `NODE_ENV=development` or `test`. Fake provider, production and live configurations never trigger a mock probe. A probe uses the existing local-only Calls client: a 2.5-second timeout, 64KiB maximum response and no followed redirects. Concurrent readiness requests share an in-flight probe; later requests probe again, so a recovered service can immediately become ready. The probe validates health/service identity, not account credentials, operator browser availability, reverse Docker networking, signed callbacks, WSS, speech or a public tunnel. Start retains its existing preflight/control checks; readiness is not authorization to call.

Overall `ready` requires valid configuration/storage, simulator mode, and a successful mock probe when that transport is enabled. `/health` remains independent of the emulator: mock outages do not cause Docker to mark the backend unhealthy. Database access errors still fail `/health`, while readiness returns structured diagnostics. An active call or unresolved reservation does not fail dependency readiness; call-start concurrency rules still apply.

Each capability has `{ name, enabled, ready }`. `enabled` reports configuration/code availability; `ready` additionally requires validated local prerequisites and, for the mock transport capabilities, a successful mock probe. A disabled capability is never ready:

| Capability | Enabled when |
| --- | --- |
| `scripted_calls`, `approvals` | Simulator mode. |
| `manual_mock_calls`, `mock_relay`, `mock_status_callbacks` | The complete mock transport gate is enabled. |
| `history`, `automatic_retention` | Installed in every mode; readiness depends on local prerequisites. |
| `test_rate_budgets` | Simulator mode with an explicit test rate. |
| `live_calls`, `dialogue_integration`, `provider_billing` | Always false until their real integrations are implemented. |

For example, with the mock enabled but stopped, the endpoint returns:

```json
{
  "mode": "simulator",
  "ready": false,
  "voiceEngine": null,
  "checks": [
    { "name": "storage", "status": "ready", "message": "SQLite application tables are readable" },
    { "name": "configuration", "status": "ready", "message": "Server configuration and stored settings are valid" },
    { "name": "mock", "status": "failed", "message": "Local mock health check failed or timed out" },
    { "name": "telephony", "status": "ready", "message": "Scripted fake telephony is installed; real calling is disabled" },
    { "name": "voice", "status": "failed", "message": "Local mock relay handler is enabled; callback and WebSocket round trips have not been probed" },
    { "name": "dialogue", "status": "ready", "message": "Scripted dialogue is installed; no model integration is enabled" },
    { "name": "tunnel", "status": "not_required", "message": "Local development needs no public tunnel" }
  ],
  "capabilities": [
    { "name": "scripted_calls", "enabled": true, "ready": true },
    { "name": "manual_mock_calls", "enabled": true, "ready": false },
    { "name": "mock_relay", "enabled": true, "ready": false },
    { "name": "mock_status_callbacks", "enabled": true, "ready": false },
    { "name": "history", "enabled": true, "ready": true },
    { "name": "approvals", "enabled": true, "ready": true },
    { "name": "automatic_retention", "enabled": true, "ready": true },
    { "name": "test_rate_budgets", "enabled": false, "ready": false },
    { "name": "live_calls", "enabled": false, "ready": false },
    { "name": "dialogue_integration", "enabled": false, "ready": false },
    { "name": "provider_billing", "enabled": false, "ready": false }
  ]
}
```

Messages are fixed, non-secret descriptions: no configured origins/paths, credentials, tokens, remote response bodies or exception details appear in responses or logs. The check results do not include account identifiers or raw configuration values. UI clients should display checks and use the relevant capability's `ready` flag rather than disabling all local features when only the mock is unavailable. The simple development console's existing Start preflight remains authoritative; full settings/readiness presentation is a booking-UI task.

Docker checks cover healthy/failed/recovered and disabled mocks, bounded/unresponsive probes, concurrent requests, malformed/oversized/redirected responses, connection refusal, invalid stored settings, inaccessible database tables, sanitized diagnostics, capability gates and private-listener/origin isolation.
