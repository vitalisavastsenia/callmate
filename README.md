# CallMate

CallMate is a personal call assistant for handling conversations in a language you do not speak. You describe what you need in English, and the assistant calls a business in Spanish, negotiates within your instructions, and reports the result in English.

The first use case is booking a barbershop appointment in Spain. The proposed app runs on your computer, with Twilio providing phone calls and speech services. It does not require AWS or Azure accounts or infrastructure.

## Product and engineering documents

Read the documents in this order:

1. [Requirements](docs/requirements.md): personal-use scope, UI, booking rules, and acceptance criteria.
2. [Architecture](docs/architecture.md): local components, Twilio integration, conversation flow, data model, and failure handling.
3. [Technology stack](docs/tech-stack.md): recommended tools, Twilio service choices, estimated costs, and implementation milestones.
4. [Three-engineer delivery plan](docs/mvp-delivery-plan.md): workstreams, task ownership, shared interfaces, dependencies, and PoC/MVP completion criteria.
5. [Three-engineer integration agreement](docs/engineering-contract.md): scope boundaries, deliverables, independent development, handoffs, merge order, and joint acceptance of one app.
6. [Shared interfaces v1](docs/interfaces.md): technical reference for executable schemas, API routes, event/reconnect protocol, and dialogue/voice boundaries.
7. [Backend to UI message contract](docs/ui-message-contract.md): case-by-case HTTP/SSE rules, payload formats, JSON examples, and expected UI behavior.

The shared TypeScript contracts package and Zeus Llama UI workflow are implemented. The UI includes a standalone simulator, a natural-language Home flow, a full manual Request form with searchable local contacts and CSV/vCard import, generic request types, tone and notes, editable boundaries, Stop, expiring approvals, explicit outcomes, Summary with history and Repeat, calendar export, remembered shareable details, readiness checks, and browser tests. The browser client uses the shared v1 HTTP/SSE contract. Backend/provider integration remains to be built and verified; see the [UI scope calibration](apps/web/UI-CALIBRATION.md).

## Getting started

```sh
git clone git@github.com:vitalisavastsenia/callmate.git
cd callmate
```

Read [AGENTS.md](AGENTS.md) before making changes. It contains the working instructions for Codex and the project's Git conventions.

Use Node.js 24 or newer. Start the web demo from the repository root:

```sh
npm ci
VITE_MOCK=true npm run dev
```

Open the local URL printed by Vite (normally `http://127.0.0.1:5173`). No backend, credentials, or real calls are involved in mock mode. See [apps/web/README.md](apps/web/README.md) for the demo flow, client boundaries, and backend mode.

Validate the workspace:

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds the contracts and runs offline contract and web-client checks. It does not make calls. `npm run build` generates the contracts package's JavaScript/declarations and the production web app in `apps/web/dist`. `npm run typecheck` checks both workspaces. Run `npm run test:e2e --workspace @callmate/web` for isolated Playwright checks in installed Google Chrome; this starts fake UI test servers on ports 5174/5175 and never makes real calls.

## Repository files

- `README.md`: project overview and setup instructions.
- `AGENTS.md`: Codex workflow, branch naming, commit conventions, and verification expectations.
- `.gitignore`: excludes local environment files, operating-system artifacts, and temporary files.
- `docs/`: product requirements, architecture, and technology decisions.
- `packages/contracts/`: shared runtime schemas, types, routes, adapter interfaces, fixtures, and contract checks.
- `apps/web/`: React, Vite, TypeScript, and Tailwind web UI, with a standalone mock call.

## Development workflow

Use `main` as the primary branch. Create focused working branches such as `feat/add-call-history`, `fix/handle-empty-contact`, or `docs/update-setup`. If a task has an issue key, include it after the branch type, for example `feat/odyssey-2026-add-call-history`.

Use Conventional Commits by default, for example `feat(calls): add call history`. Explicitly requested commit messages take precedence.

Keep commits focused, inspect the staged diff, and run relevant checks before committing. Build and test commands will be documented here when application tooling is introduced. Never commit credentials or local `.env` files; use placeholder values in `.env.example`.
