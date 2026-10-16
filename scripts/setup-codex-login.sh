#!/bin/sh
set -eu
# Copy only the credential file, never host config/history/skills. Do not print it.
cd "$(dirname "$0")/.."
callmate_auth_file="${CODEX_HOME:-$HOME/.codex}/auth.json"
if [ ! -f "$callmate_auth_file" ]; then
  echo "Saved Codex auth.json was not found. See docs/docker-development.md for Docker device login." >&2
  exit 1
fi
docker compose -f compose.yaml -f compose.codex.yaml run --rm --no-deps --user root \
  --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  -v "$callmate_auth_file:/run/callmate-auth.json:ro" zeus-llama \
  node --input-type=module -e 'import {copyFileSync,chmodSync,chownSync} from "node:fs"; chmodSync("/codex",0o700); chownSync("/codex",1000,1000); copyFileSync("/run/callmate-auth.json","/codex/auth.json"); chmodSync("/codex/auth.json",0o600); chownSync("/codex/auth.json",1000,1000);'
docker compose -f compose.yaml -f compose.codex.yaml run --rm --no-deps zeus-llama codex login status
