# CallMate

CallMate is a personal call assistant for handling conversations in a language you do not speak. You describe what you need in English, and the assistant calls a business in Spanish, negotiates within your instructions, and reports the result in English.

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

The shared contracts and TypeScript/Fastify backend scaffold are implemented. The UI, simulator, dialogue, and real calling adapters are still to be built. Readiness reports calling as unavailable in both simulator and live modes until those adapters exist.

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
curl http://127.0.0.1:3000/api/v1/readiness
```

The private API is published at `127.0.0.1:3000`; the separate callback listener is at `127.0.0.1:3001` and currently returns 404 for all routes. No UI is served yet. SQLite persists in the `callmate-data` Docker volume.

Run type checking and offline tests inside a disposable container:

```sh
docker compose --profile checks run --build --rm checks
```

Use `docker compose logs -f server` for logs and `docker compose down` to stop/remove containers while preserving the database volume. See the [Docker guide](docs/docker-development.md) for configuration and endpoint examples.

## Repository files

- `README.md`: project overview and setup instructions.
- `AGENTS.md`: Codex workflow, branch naming, commit conventions, and verification expectations.
- `.gitignore`: excludes local environment files, operating-system artifacts, and temporary files.
- `docs/`: product requirements, architecture, and technology decisions.
- `packages/contracts/`: shared runtime schemas, types, routes, adapter interfaces, fixtures, and contract checks.
- `apps/server/`: backend configuration, Fastify listeners, SQLite migrations/storage, and server tests.
- `Dockerfile`, `compose.yaml`, `.dockerignore`: container build, runtime, persistent data volume, and build-context exclusions.

## Development workflow

Use `main` as the primary branch. Create focused working branches such as `feat/add-call-history`, `fix/handle-empty-contact`, or `docs/update-setup`. If a task has an issue key, include it after the branch type, for example `feat/odyssey-2026-add-call-history`.

Use Conventional Commits by default, for example `feat(calls): add call history`. Explicitly requested commit messages take precedence.

Keep commits focused, inspect the staged diff, and run the container checks before committing. Never commit credentials or local `.env` files; use placeholder values in `.env.example`.
