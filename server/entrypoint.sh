#!/usr/bin/env bash
set -euo pipefail

LOCAL_UID=${LOCAL_UID:-0}
LOCAL_GID=${LOCAL_GID:-$LOCAL_UID}

maybe_chown() {
  if [ "$LOCAL_UID" != "0" ]; then
    for path in "$@"; do
      if [ -e "$path" ]; then
        chown -R "$LOCAL_UID:$LOCAL_GID" "$path" || true
      fi
    done
  fi
}

run_as() {
  if [ "$LOCAL_UID" = "0" ]; then
    "$@"
  else
    gosu "$LOCAL_UID:$LOCAL_GID" "$@"
  fi
}

exec_as() {
  if [ "$LOCAL_UID" = "0" ]; then
    exec "$@"
  else
    exec gosu "$LOCAL_UID:$LOCAL_GID" "$@"
  fi
}

if [ "${APP_ENV:-dev}" != "dev" ]; then
  maybe_chown /vault /opt/server
  if [ -x /opt/server/server ]; then
    echo "[server] prod mode"
    exec_as /opt/server/server
  else
    echo "[server] prod mode but no binary. Build first."
    exec sleep infinity
  fi
fi

echo "[server] dev mode"
maybe_chown /vault /workspace /usr/local/cargo
cd /workspace

run_as cargo build || true
exec_as cargo watch -x "run"
