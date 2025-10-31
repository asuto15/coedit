#!/usr/bin/env bash
set -euo pipefail

if [ "${APP_ENV:-dev}" = "dev" ] || [ ! -d /opt/app ]; then
  echo "[web] dev mode"
  cd /workspace
  if [ ! -d node_modules ] || [ -z "$(ls -A node_modules 2>/dev/null || true)" ]; then
    echo "[web] Installing dependencies..."
    yarn install || true
  fi

  exec yarn dev --hostname 0.0.0.0 --port 3000
fi

echo "[web] prod mode"
cd /opt/app
exec yarn start -H 0.0.0.0 -p 3000
