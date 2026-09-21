#!/usr/bin/env bash
# Build and run the ad-detection stack on dev01.
#
# Runs from a workstation: ships the repo to dev01 over rsync, then builds and
# starts the compose stack there. Nothing is pushed to any registry and no
# other repo is touched.
#
# Usage:
#   DEEPSEEK_API_KEY=sk-... ./deploy-dev01.sh
#
# Requires: SSH access to dev01 as a user in the docker group.

set -euo pipefail

HOST="${HOST:-rt@10.1.1.50}"
REMOTE_DIR="${REMOTE_DIR:-/srv/audiobookshelf-adskip}"
SSH_OPTS="${SSH_OPTS:--o IdentityAgent=none -o IdentitiesOnly=yes -i ${HOME}/.ssh/id_ed25519}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "DEEPSEEK_API_KEY is not set" >&2
  exit 1
fi

echo "==> Checking dev01"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" 'docker --version && docker compose version' >/dev/null

echo "==> Syncing repo to ${HOST}:${REMOTE_DIR}"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete \
  --exclude node_modules \
  --exclude client/node_modules \
  --exclude client/dist \
  --exclude dist-server \
  --exclude .git \
  --exclude 'docker/ad-detection/data' \
  -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/" "$HOST:$REMOTE_DIR/"

echo "==> Writing .env"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "cat > '$REMOTE_DIR/docker/ad-detection/.env'" <<ENVEOF
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
ABS_PORT=${ABS_PORT:-13378}
WHISPER_THREADS=${WHISPER_THREADS:-3}
TZ=${TZ:-America/New_York}
ENVEOF
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "chmod 600 '$REMOTE_DIR/docker/ad-detection/.env'"

echo "==> Building and starting (first build takes several minutes)"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "cd '$REMOTE_DIR/docker/ad-detection' && docker compose up -d --build"

echo "==> Status"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "cd '$REMOTE_DIR/docker/ad-detection' && docker compose ps"

echo
echo "Audiobookshelf:  http://10.1.1.50:${ABS_PORT:-13378}"
echo "Next: create the admin account, add a podcast library, then"
echo "      Settings -> Ad Detection -> enable, transcription provider"
echo "      'OpenAI-compatible API', base URL http://whisper:8000/v1"
