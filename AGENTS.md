# Codex working instructions

## Before changing files

- Read this file and `README.md`. Follow more specific `AGENTS.md` instructions in any directory you edit.
- Inspect `git status --short --branch` and the relevant files before starting.
- Preserve existing user changes. Do not overwrite, discard, or stage unrelated work.
- Keep changes focused on the requested task. Update documentation when setup or behavior changes.
- Do not invent build or test commands. Discover the project's tooling first and document it when introduced.

## Branch conventions

- `main` is the primary branch. Do not rename it or rewrite its history unless explicitly requested.
- Create a working branch before implementation unless the user explicitly requests work on the current branch or on `main`.
- Use `<type>/<short-description>` with lowercase, hyphen-separated descriptions.
- Allowed branch types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, and `ci`.
- Include an existing issue key in lowercase when supplied: `feat/odyssey-2026-add-call-history`. Do not invent issue keys.
- Keep each branch focused on one task.

## Commit conventions

- Use Conventional Commits by default: `<type>(<optional-scope>): <imperative summary>`.
- Commit types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, and `revert`.
- Examples: `feat(calls): add call history`, `fix(contacts): handle missing phone numbers`, and `docs: document local setup`.
- Keep the subject concise, preferably at most 72 characters, without a trailing period. Add a body when the reason or tradeoffs need explanation.
- If an issue key exists, reference it in the body, for example `Refs: ODYSSEY-2026`.
- Use an exact commit message supplied by the user even when it differs from these defaults.
- Make focused commits. Stage explicit file paths and review `git diff --cached` before committing.
- Commit only when the user requests it or has already authorized commits for the task.

## Required secret checks before pushing

- Before every push, identify the destination remote and refs, then inspect every outgoing commit and its changes for secrets. For a new remote branch, check all history that would be newly published. Checking only the final working tree or net diff is insufficient: secrets added and removed in intermediate commits are still exposed by a push.
- Check code, configuration, scripts, documentation, fixtures, generated files, and commit messages for passwords, API keys, access tokens, private keys, credentials in URLs or connection strings, and sensitive local environment files. `.gitignore` does not protect files already tracked by Git.
- Run the project's secret scanner over the outgoing history when available, and review the changes manually. If no scanner is available, state that limitation and perform the manual review; do not claim an automated scan passed.
- Do not push while suspected secrets remain unresolved. Remove secrets from all outgoing commits before publishing, following the authorization rules for history changes below. If a real secret has already been shared, flag it for revocation or rotation. Never reproduce secret values in logs, comments, or status reports; report only affected paths, commit IDs, and secret types.
- Before pushing, report the scope reviewed, checks performed, and any limitations. A completed secret check does not itself authorize a push.

## Verification and safety

- Run the relevant available checks before committing. If no runnable tooling exists, inspect the diff and run `git diff --check` and `git diff --cached --check`.
- Never claim a check passed unless it actually ran. Report checks that could not run and why.
- Keep credentials, tokens, private keys, and local environment files out of Git. Commit only safe configuration examples with placeholder values.
- Do not use destructive Git operations such as `reset --hard`, `clean -fd`, or forced checkout without explicit authorization.
- Do not amend commits, rebase shared history, force-push, delete branches, push to a remote, merge a pull request, or create a release unless explicitly authorized.
- Finish by reporting the branch, changes, checks performed, and commit hash if a commit was created. State whether changes remain local.
