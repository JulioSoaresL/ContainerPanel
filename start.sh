#!/usr/bin/env bash
# Sobe o docker-panel e abre no navegador.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PANEL_PORT:-7777}"
[[ -d node_modules ]] || npm install --omit=dev
export PANEL_TOKEN="${PANEL_TOKEN:-$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")}"

(sleep 1 && command -v xdg-open >/dev/null && xdg-open "http://127.0.0.1:${PORT}/?t=${PANEL_TOKEN}" >/dev/null 2>&1) &
exec node server.js
