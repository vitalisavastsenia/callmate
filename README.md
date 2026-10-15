# CallMate

This repository is the starting point for CallMate. Application code, the technology stack, and setup commands have not been added yet.

## Getting started

```sh
git clone git@github.com:vitalisavastsenia/callmate.git
cd callmate
```

Read [AGENTS.md](AGENTS.md) before making changes. It contains the working instructions for Codex and the project's Git conventions.

## Repository files

- `README.md`: project overview and setup instructions.
- `AGENTS.md`: Codex workflow, branch naming, commit conventions, and verification expectations.
- `.gitignore`: excludes local environment files, operating-system artifacts, and temporary files.

## Development workflow

Use `main` as the primary branch. Create focused working branches such as `feat/add-call-history`, `fix/handle-empty-contact`, or `docs/update-setup`. If a task has an issue key, include it after the branch type, for example `feat/odyssey-2026-add-call-history`.

Use Conventional Commits by default, for example `feat(calls): add call history`. Explicitly requested commit messages take precedence.

Keep commits focused, inspect the staged diff, and run relevant checks before committing. Build and test commands will be documented here when application tooling is introduced. Never commit credentials or local `.env` files; use placeholder values in `.env.example`.
