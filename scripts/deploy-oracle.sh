#!/usr/bin/env bash
# Safe Chusky release path for the Oracle VM. It builds before touching the
# running PM2 worker and reloads only after a successful build.
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Deployment stopped: tracked local changes are present. Preserve or commit them first."
  git status --short
  exit 1
fi

git pull --ff-only origin main
npm ci --no-audit --no-fund
NODE_OPTIONS="--max-old-space-size=384" npm run build

# A PM2 reload keeps the current worker online until the replacement reports
# its full readiness contract. Never use `restart` for normal releases.
pm2 reload ecosystem.config.cjs --only chusky --update-env
pm2 save

curl --fail --silent --show-error http://127.0.0.1:3003/health/live
echo "Chusky deployment is healthy."
