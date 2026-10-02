#!/bin/sh
# Prepares the pristine harness in place: dependencies, the shadcn/ui primitives demos may compose, warm caches,
# and a git snapshot that run-job.mjs resets to before every job.
# Used by the container image (Dockerfile: all phases) and by the coding agents' sandboxes, so both build identically.
# The agents' sandboxes limit each setup command to 120 s, so they run one phase per command:
#   sh setup.sh deps | browser-deps | browser | ui | build | snapshot
set -eu
cd "$(dirname "$0")"
phase="${1:-all}"
run() { [ "$phase" = "all" ] || [ "$phase" = "$1" ]; }

if run deps; then
  pnpm install --frozen-lockfile --ignore-scripts
fi
# Chromium for render.mjs (runtime checks, screenshots, recordings). The system libraries need root (apt)
if run browser-deps; then
  ./node_modules/.bin/playwright install-deps chromium >/dev/null
fi
if run browser; then
  ./node_modules/.bin/playwright install chromium >/dev/null
fi
# Keep in sync with PREINSTALLED_UI in src/infrastructure/openai-demo-writer.ts
if run ui; then
  ./node_modules/.bin/shadcn add button card input label badge separator avatar switch checkbox textarea tabs --yes --overwrite --silent
fi
if run build; then
  ./node_modules/.bin/vite build >/dev/null
  ./node_modules/.bin/tsc --noEmit -p tsconfig.json >/dev/null || true
  rm -rf dist
fi
if run snapshot; then
  git init -q
  git add -A
  git -c user.email=harness@local -c user.name=harness commit -qm harness
fi
