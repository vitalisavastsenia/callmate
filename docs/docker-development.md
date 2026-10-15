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

The Docker health check tests `/health`. Healthy means the process and SQLite are available; it does not mean calls can start. `/api/v1/readiness` reports `ready: false` because the simulator, telephony, voice, and dialogue adapters are not implemented yet. Switching to `live` does not bypass that limitation or cause a call.

## 2. Configuration

Defaults work without `.env`. For overrides, copy `.env.example` to ignored `.env` and edit it, then recreate the container with the startup command. Compose injects only the explicitly listed settings; it does not forward the whole host environment or `.env` file.

| Setting | Default | Rule |
| --- | --- | --- |
| `CALLMATE_MODE` | `simulator` | `simulator` or `live`; both currently report calling unavailable. |
| `CALLMATE_API_PORT` | `3000` | Integer 1–65535; same port inside the container and on host loopback. |
| `CALLMATE_CALLBACK_PORT` | `3001` | Integer 1–65535; different from the API port. |
| `CALLMATE_LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug`. |
| `CALLMATE_DATA_DIR` | `/data` | Set by Compose to the volume mount; standalone image configuration requires an absolute non-root writable app directory. |

Twilio and LLM credentials are not needed or consumed in this step. Provider configuration/Compose injection belongs to the later adapters. No secrets are built into the image: `.dockerignore` permits only workspace manifests, source, migrations, and offline tests; environment files, host dependencies, build artifacts, Git history, docs, and local data stay outside the build context.

Invalid configuration fails startup. Startup/error diagnostics deliberately omit supplied values, filesystem paths, provider tokens, raw request URLs/bodies/headers, and exception details. Request logs contain only a generated request ID, method, and status. Do not add arbitrary transcript/config objects to logs in future adapters.

## 3. Listener and route boundaries

Both Fastify listeners bind `0.0.0.0` **inside the container** so Docker forwarding can reach them. Compose publishes each port on host `127.0.0.1` only. Do not change the host binding to a public interface.

| Listener | Implemented routes |
| --- | --- |
| Private API, default host port 3000 | `GET /health`, `GET /api/v1/readiness`, `GET /api/v1/settings`, `PUT /api/v1/settings`. |
| Callback listener, default host port 3001 | No accepted routes yet; all requests return the shared structured 404 error. |

Settings use the existing shared schemas. Example update:

```sh
curl --request PUT http://127.0.0.1:3000/api/v1/settings \
  --header 'Content-Type: application/json' \
  --data '{"defaultCallLimits":{"maxDurationSeconds":300,"maxEstimatedCost":{"amountMinor":200,"currency":"USD"}},"transcriptRetentionDays":14}'
```

Private requests require a recognized loopback Host and, when present, a same-app Origin. Cross-site browser requests are rejected, and mutation requests require JSON. Use a same-origin UI or a future development proxy; cross-origin CORS access is not enabled. Error bodies use `ApiErrorSchema`; validation errors do not echo supplied values. Settings cannot include provider credentials.

The remaining plan/call/SSE/history/approval endpoints are not implemented and return 404. They must be implemented using [shared interfaces](interfaces.md) in the subsequent work. No Twilio callback/WSS route is active until signature validation and session correlation exist. A future host tunnel must forward only port 3001, never the private API.

## 4. SQLite persistence and migrations

On startup, the server creates `/data/callmate.sqlite`, enables WAL and foreign keys, and applies numbered SQL migrations from `apps/server/migrations/`. `schema_migrations` records each version, filename, checksum, and application time. Applied migrations are immutable; append a new numbered file for changes. Missing, edited, duplicate, or unknown applied versions fail startup. Migration SQL and version records are committed in one transaction.

The initial migration creates and seeds application settings: a 300-second maximum call duration, USD 2.00 estimated call-cost limit, and 30-day transcript retention. These are settings only; call enforcement and retention processing come later. Settings survive container restart/recreation. The volume directory has mode 0700 and database file mode 0600; SQLite itself is not encrypted.

`docker compose down` preserves the named data volume. Ordinary builds and checks do not delete it. Do not run two server containers against the same volume or mount a host repository directory over `/data`.

## 5. Build and checks inside Docker

```sh
docker compose build server
docker compose --profile checks run --build --rm checks
```

The checks service uses the build image and runs `npm run typecheck` and `npm test` entirely in its container. The root workspace scripts build the contracts before consumers and run both contract and server checks. Server tests use temporary databases inside the disposable checks container; they do not mount the live data volume, publish ports, make phone calls, or contact model providers.

Checks cover configuration validation, migration rollback/history integrity, settings persistence and permissions, HTTP schemas, local-origin controls, listener separation, truthful readiness, log/error redaction, partial-startup cleanup, and actual HTTP startup/shutdown.

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
