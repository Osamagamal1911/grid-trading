#!/bin/bash
#
# alphaGrid portable setup (Part A portability).
#
# Fresh-machine bootstrap with NO sudo and NO global mutation:
#   1. Node v22.12.0 user-local (~/.local/node-v22, x86_64 + arm64)
#   2. pnpm 10.12.1 user-local
#   3. pnpm install (workspace deps + Prisma client generate)
#   4. moon binary postinstall workaround (pnpm ignores build scripts; see DECISIONS.md D17)
#   5. tsc --build for packages/* (/dts project-reference artifacts typecheck needs)
#   6. prisma migrate (local dev.db; creates gitignored .env from .env.example if missing)
#   7. app build (dist/ for bin/cli.sh — gitignored, absent on fresh clones)
#
# Idempotent: safe to re-run. Skips every step whose result is already present.
# Usage: ./scripts/setup.sh   (run from the repo root)
#
set -euo pipefail

NODE_VERSION="v22.12.0"
PNPM_VERSION="10.12.1"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export PATH="$HOME/.local/node-v22/bin:$PATH"

arch="$(uname -m)"
case "$arch" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *)
    echo "setup.sh: unsupported architecture '$arch' (need x86_64 or arm64)" >&2
    exit 1
    ;;
esac

# --- 1. Node -----------------------------------------------------------
if command -v node >/dev/null 2>&1 && [ "$(node --version)" = "$NODE_VERSION" ]; then
  echo "setup.sh: node $NODE_VERSION already present — skipping install"
else
  echo "setup.sh: installing node $NODE_VERSION ($NODE_ARCH) to ~/.local/node-v22 ..."
  mkdir -p "$HOME/.local" /tmp/opencode
  tarball="/tmp/opencode/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  if [ ! -f "$tarball" ]; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o "$tarball"
  fi
  rm -rf "$HOME/.local/node-v22"
  tar -xJf "$tarball" -C /tmp/opencode/
  mv "/tmp/opencode/node-$NODE_VERSION-linux-$NODE_ARCH" "$HOME/.local/node-v22"
  export PATH="$HOME/.local/node-v22/bin:$PATH"
  echo "setup.sh: node $(node --version) ready"
fi

# --- 2. pnpm -----------------------------------------------------------
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version)" = "$PNPM_VERSION" ]; then
  echo "setup.sh: pnpm $PNPM_VERSION already present — skipping install"
else
  echo "setup.sh: installing pnpm $PNPM_VERSION ..."
  npm install -g "pnpm@$PNPM_VERSION" >/dev/null 2>&1
  echo "setup.sh: pnpm $(pnpm --version) ready"
fi

# --- 3. install --------------------------------------------------------
echo "setup.sh: pnpm install ..."
pnpm install

# --- 4. moon binary (D17 workaround) -----------------------------------
# Runs AFTER install: the postinstall script lives inside node_modules, which
# does not exist on a fresh clone. pnpm ignores build scripts, so without this
# `moon` is a broken wrapper (ENOENT on its native binary).
MOON_CLI_DIR="$(find node_modules/.pnpm -maxdepth 1 -name '@moonrepo+cli@*' | head -n 1)/node_modules/@moonrepo/cli"
if [ -x "$MOON_CLI_DIR/moon" ]; then
  echo "setup.sh: moon binary present — skipping postinstall"
elif [ -f "$MOON_CLI_DIR/postinstall.js" ]; then
  echo "setup.sh: restoring moon binary (postinstall workaround, see D17) ..."
  node "$MOON_CLI_DIR/postinstall.js"
else
  echo "setup.sh: FATAL: moon package not found under node_modules/.pnpm (@moonrepo+cli@*)" >&2
  exit 1
fi

# --- 5. project-reference build (/dts artifacts typecheck needs) ------
# NOTE: app + pro/* are excluded on purpose — app has 4 pre-existing typecheck
# errors on the untouched tree (D18) and pro/* is a private submodule.
echo "setup.sh: tsc --build packages/* ..."
./node_modules/.bin/tsc --build \
  packages/types packages/tools packages/indicators packages/exchanges \
  packages/backtesting packages/bot-templates packages/bot-processor packages/db \
  packages/event-bus packages/logger packages/bot packages/trpc packages/prisma \
  packages/tsconfig

# --- 6. local .env + migrate -------------------------------------------
if [ ! -f ".env" ]; then
  echo "setup.sh: creating gitignored .env from .env.example (local dev only, no secrets)"
  cp .env.example .env
else
  echo "setup.sh: .env exists — leaving untouched (never overwritten)"
fi
echo "setup.sh: prisma migrate ..."
./node_modules/.bin/moon run prisma:migrate 2>&1 | tail -n 3

# --- 7. app build (dist/ the CLI runs from; gitignored build output) --------
# bin/cli.sh executes app/dist/cli.mjs, which does not exist on a fresh clone.
# tsup bundles without type-gating, so the 2 pre-existing app typecheck errors
# do not block it (D18).
echo "setup.sh: app build ..."
./node_modules/.bin/moon run app:build 2>&1 | tail -n 2

echo ""
echo "setup.sh: DONE — node $(node --version), pnpm $(pnpm --version)"
echo "Next: export BINANCE_API_KEY/SECRET (see runbook), then ./bin/cli.sh up -d"
