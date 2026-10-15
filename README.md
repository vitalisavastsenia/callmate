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

The shared TypeScript contracts and dialogue/booking library are implemented. The dialogue library supports Codex CLI through a ChatGPT login and an optional OpenAI Responses API adapter; the UI, application backend, and telephone adapters are not yet built.

## Getting started

```sh
git clone git@github.com:vitalisavastsenia/callmate.git
cd callmate
```

Read [AGENTS.md](AGENTS.md) before making changes. It contains the working instructions for Codex and the project's Git conventions.

Use Node.js 24 or newer to validate the shared contracts:

```sh
npm ci
npm run typecheck
npm test
```

`npm test` builds the contracts and runs offline checks. It does not make calls. Use `npm run build` to generate the package's JavaScript and declarations. No application start command exists yet.

The dialogue package is not registered in the root workspace yet. After installing
root dependencies, build contracts and check dialogue with:

```sh
npm run build --workspace @callmate/contracts
npm --prefix packages/dialogue run typecheck
npm --prefix packages/dialogue test
```

For a text-only turn using your ChatGPT subscription, install Codex CLI, run
`codex login` and choose ChatGPT, then build dialogue and run:

```sh
npm --prefix packages/dialogue run build
node packages/dialogue/examples/codex-turn.mjs < packages/dialogue/examples/ambiguous-time.json
```

This uses your included Codex limits without an API key or separate API billing.
See the [CLI adapter setup](packages/dialogue/README.md#codex-cli-with-chatgpt-login).
The separately billed API path remains an explicit option in
`packages/dialogue/examples/openai-turn.mjs`; only that example needs
`OPENAI_API_KEY` and `OPENAI_MODEL` from a local `.env`.
Offline tests require no account, key, or network.

## Repository files

- `README.md`: project overview and setup instructions.
- `AGENTS.md`: Codex workflow, branch naming, commit conventions, and verification expectations.
- `.gitignore`: excludes local environment files, operating-system artifacts, and temporary files.
- `docs/`: product requirements, architecture, and technology decisions.
- `packages/contracts/`: shared runtime schemas, types, routes, adapter interfaces, fixtures, and contract checks.
- `packages/dialogue/`: dialogue planning, booking policy, Spanish templates, English results, and the Codex CLI/API adapters.

## Development workflow

Use `main` as the primary branch. Create focused working branches such as `feat/add-call-history`, `fix/handle-empty-contact`, or `docs/update-setup`. If a task has an issue key, include it after the branch type, for example `feat/odyssey-2026-add-call-history`.

Use Conventional Commits by default, for example `feat(calls): add call history`. Explicitly requested commit messages take precedence.

Keep commits focused, inspect the staged diff, and run relevant checks before committing. Build and test commands will be documented here when application tooling is introduced. Never commit credentials or local `.env` files; use placeholder values in `.env.example`.
