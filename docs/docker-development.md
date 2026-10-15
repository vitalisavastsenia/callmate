# Docker backend development

The backend uses Node.js 24, TypeScript, Fastify, and SQLite via `better-sqlite3`. Docker builds the shared contracts and backend and runs the server; the host needs Docker Desktop/Engine and Compose, without Node.js or a local database server.

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
| Private API, default host port 3000 | `GET /health` and all [shared HTTP/SSE routes](interfaces.md#4-private-http-api), operating on persisted simulator attempts. |
| Callback listener, default host port 3001 | No accepted routes yet; all requests return the shared structured 404 error. |

Settings use the existing shared schemas. Example update:

```sh
curl --request PUT http://127.0.0.1:3000/api/v1/settings \
  --header 'Content-Type: application/json' \
  --data '{"defaultCallLimits":{"maxDurationSeconds":300,"maxEstimatedCost":{"amountMinor":200,"currency":"USD"}},"transcriptRetentionDays":14}'
```

Private requests require a recognized loopback Host and, when present, a same-app Origin. Cross-site browser requests are rejected. POST/PUT commands require JSON; DELETE conversation requests have no body. Use a same-origin UI or a future development proxy; cross-origin CORS access is not enabled. Error bodies use `ApiErrorSchema`; validation errors do not echo supplied values. Settings cannot include provider credentials.

No Twilio callback/WSS route is active until signature validation and session correlation exist. A future host tunnel must forward only port 3001, never the private API.

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

Checks cover configuration, migrations/transaction rollback, storage permissions, schemas, local-origin controls, listener separation, log/error redaction, scripted outcomes, approval/version/expiry handling, idempotency, Stop with a late model result, duration caps, restart recovery, history/deletion, and real HTTP/SSE replay/live/reset/shutdown.

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
