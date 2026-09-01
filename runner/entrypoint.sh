#!/bin/bash
set -euo pipefail

export RUNNER_ALLOW_RUNASROOT=1

cd /actions-runner

if [ ! -f .runner ]; then
  if [ -z "${REPO_URL:-}" ] || [ -z "${RUNNER_TOKEN:-}" ]; then
    echo "[runner] REPO_URL and RUNNER_TOKEN must be set for first-time registration." >&2
    exit 1
  fi
  echo "[runner] Not yet registered - configuring against $REPO_URL ..."
  ./config.sh \
    --url "$REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "${RUNNER_NAME:-nas-daily-content-ideas}" \
    --work _work \
    --unattended \
    --replace
else
  echo "[runner] Already registered (found .runner in the persisted volume) - skipping config.sh."
fi

cleanup() {
  echo "[runner] Caught signal, shutting down..."
  exit 0
}
trap cleanup SIGINT SIGTERM

echo "[runner] Starting..."
exec ./run.sh
