# Zeus Llama technology stack

Status: installed stack and integration boundaries, updated 2026-10-16. See [architecture](architecture.md) for flows and [Docker development](docker-development.md) for configuration. Twilio remains planned; the running stack uses simulations.

## 1. Implemented stack

| Layer | Implementation | Boundary |
| --- | --- | --- |
| Workspaces | npm: contracts, dialogue, server and web | Root scripts include all four packages; standalone mock has its own manifest/lockfile. |
| Runtime | Node.js ≥24, TypeScript; Docker base Node 24 Bookworm slim | UI assets and backend in one application container. |
| UI | React 19, Vite 7, Tailwind CSS 4 | Compiled static assets; optional Vite dev profile. React-controlled forms and shared schemas; no React Hook Form. |
| HTTP/files | Fastify 5, `@fastify/static` | Private UI/API/console and separate callback listener in one process. |
| Relay | `ws` 8 | Development mock upgrades and bounded protocol parsing; no `@fastify/websocket`. |
| Browser updates | Fetch-based SSE and JSON HTTP | Cookie auth, cursor replay/reset, snapshot recovery; mutations remain HTTP. |
| Contracts | Zod 4 and inferred TypeScript types | Runtime validation; schema validity does not grant booking authority. |
| Storage | `better-sqlite3` 13, WAL, migrations 001–008 | Transactional snapshots/events, unique active-attempt index; no separate DB service. |
| Authentication | Node crypto scrypt, opaque sessions, SQLite throttling | Single local owner; HttpOnly/SameSite cookie; no external identity service. |
| Dialogue | `@callmate/dialogue` | Policy/reducers, four languages, 15 templates, controlled speech and English translations. |
| Codex | Optional pinned CLI image, saved ChatGPT login | Bounded subprocess; absent in base image; no API-key fallback. |
| OpenAI API | Native-fetch Responses adapter | Server credentials, structured proposals, cancellation and timeout. |
| Claude API | Native-fetch Anthropic Messages adapter | Provider-compatible output schema plus full local validation. |
| Secrets | Node crypto AES-256-GCM | Encrypted credentials in SQLite; master key in a separate private volume/file. |
| Mock calling | Official `twilio` SDK against local Calls subset | Synthetic destinations/IDs, signed callbacks and simulated playback; no real dialing. |
| Protocol checks | `twilio`, `fast-xml-parser`, `ws`, local fixtures | Offline REST/TwiML/WebSocket harness, separate from live integration. |
| Diagnostics | Redacted Fastify logs and private readiness API | Separate simulated/missing-live capabilities; no credential/transcript logging. |

Exact versions are in manifests, the root [lockfile](../package-lock.json) and the mock lockfile. Model/effort suggestions live in [the shared LLM contract](../packages/contracts/src/llm.ts); they are not benchmarks or live account/model discovery.

## 2. Deployment and persistence

Default Compose services are **`zeus-llama`** and **`mock-relay`**. Fastify serves UI/API at localhost:3000 and callbacks at localhost:3001; the operator is localhost:8080. Only the optional `dev` profile adds Vite at localhost:5173.

| Volume | Data |
| --- | --- |
| `callmate-data` | SQLite: calls/events/commands, contacts, auth, settings, phrases and encrypted API credentials. |
| `zeus-llm-secrets` | Master key at `/run/zeus-secrets`; preserve separately from database backups. |
| `callmate-codex` (Codex override) | CLI ChatGPT login/config at `/codex`, separate from API keys. |

Mock sessions are in memory. Browser Simulator calls/history/preferences use origin-local storage; contacts and server configuration still use SQLite. Agreements/calendar project saved outcomes rather than using a separate appointments service.

Containers use a non-root user, read-only root filesystem, temporary `/tmp`, dropped capabilities and `no-new-privileges`. Default ports bind to loopback. Local mock operation needs no public tunnel or AWS/Azure infrastructure.

## 3. Configuration boundaries

Browser call mode, backend call engine and LLM provider are independent. Browser Simulator invokes no paid inference. Backend Mock uses the configured fake/scripted or development mock transport. Backend Twilio is explicitly unavailable and rejects new Starts with `503 PROVIDER_NOT_READY`.

Settings → LLM agent selects provider, model and supported effort. Saved configuration overrides bootstrap environment values and applies without restarting. Keys are write-only; responses expose status/source only. Active reservations lock LLM/key and call-engine updates. See [LLM settings and secrets](docker-development.md#18-llm-agent-settings-and-secret-storage).

Readiness and saving credentials do not perform paid inference or prove connectivity. Reviewed mock calls require a configured dialogue engine and never fall back to scripted success. Policy and current authority are checked independently of the model.

## 4. Checks and commands

| Area | Tooling |
| --- | --- |
| Contracts/server/dialogue | Node.js test runner, Fastify injection, local HTTP/WebSocket tests and deterministic fixtures. |
| Dialogue evaluation | Scripted multilingual/policy tests and a 32-scenario Spanish evaluation; separate from real speech evaluation. |
| Web unit/client behavior | Vitest and DOM-based tests. |
| Browser integration | Playwright, including backend-backed workflow, modal/layout and history/deletion behavior. |
| Build/type checks | TypeScript across workspaces and Vite production build. |

From the repository root:

```sh
# Two-service stack.
docker compose up --build -d --wait

# Optional CLI image/login volume; follow Docker guide login steps.
docker compose -f compose.yaml -f compose.codex.yaml up --build -d --wait

# Type checks and offline workspace tests.
docker compose --profile checks run --build --rm checks

# Dialogue evaluation or offline protocol walkthrough.
docker compose --profile checks run --build --rm checks npm run evaluate --workspace @callmate/dialogue
docker compose --profile checks run --build --rm checks npm run demo:twilio-mock --workspace @callmate/server
```

The web manifest also exposes `npm run test:e2e --workspace @callmate/web`. Playwright requires browser dependencies and its configured test server; it is not run automatically by Compose `checks`. See [web verification setup](../apps/web/README.md). Ordinary tests use local/synthetic providers, not paid inference or telephone calls.

## 5. Planned Twilio and accounting

The intended real provider is **Twilio Programmable Voice + ConversationRelay**: Calls creation/control for telephony and authenticated callbacks/WSS for managed speech. A future tunnel would expose only callbacks. Media Streams, browser audio joining, recording and paid analytics are not implemented features.

Remaining work includes live provider wiring, account/origin/destination checks, speech configuration, actual playback evidence, production confirmation verification, callback/tunnel failure recovery and a supervised connectivity pilot. The [Twilio runbook](twilio-setup.md) is preparatory; selecting Twilio does not enable these components.

Current accounting uses explicit **synthetic USD test rates**, elapsed time and a matching reviewed USD budget, without fetching real bills or converting currencies. Future accounting must distinguish call routing, relay/speech, model tokens, number rental, tunnel charges, taxes and rounding/currency. Verify actual rates and account restrictions before live calling. Appointment price limits remain separate from call-cost limits.

The [delivery plan](mvp-delivery-plan.md) retains real-call PoC/pilot gates. Local HTTP/SSE, browser and mock tests establish local behavior, not telephone quality, provider entitlement or billing accuracy.
