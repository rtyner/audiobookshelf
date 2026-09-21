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
# Requires: SSH access to dev01 as a user with sudo (the account is not in the
# docker group, so docker is invoked through sudo rather than changing group
# membership on the host).

set -euo pipefail

HOST="${HOST:-rusty@10.1.1.50}"
REMOTE_DIR="${REMOTE_DIR:-/srv/audiobookshelf-adskip}"
SSH_OPTS="${SSH_OPTS:--o IdentityAgent=none -o IdentitiesOnly=yes -i ${HOME}/.ssh/id_ed25519}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The API key is optional here - it can also be set in the web UI under
# Settings -> Ad Detection after first boot.
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "note: DEEPSEEK_API_KEY not set; set the key in the web UI after boot"
fi

echo "==> Checking dev01"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" 'sudo docker --version && sudo docker compose version' >/dev/null

echo "==> Syncing repo to ${HOST}:${REMOTE_DIR}"
# shellcheck disable=SC2086
# /srv is root-owned; create the directory once and hand it to the deploy user
ssh $SSH_OPTS "$HOST" "sudo mkdir -p '$REMOTE_DIR' && sudo chown \$(id -u):\$(id -g) '$REMOTE_DIR'"
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
DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
ABS_PORT=${ABS_PORT:-13378}
WHISPER_THREADS=${WHISPER_THREADS:-4}
TZ=${TZ:-America/New_York}
ENVEOF
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "chmod 600 '$REMOTE_DIR/docker/ad-detection/.env'"

echo "==> Building and starting (first build takes several minutes)"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "cd '$REMOTE_DIR/docker/ad-detection' && sudo docker compose up -d --build"

echo "==> Status"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$HOST" "cd '$REMOTE_DIR/docker/ad-detection' && sudo docker compose ps"

echo
echo "Audiobookshelf:  http://10.1.1.50:${ABS_PORT:-13378}"
echo
echo "Next:"
echo "  1. Open it and create the admin account."
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "  2. Settings -> Ad Detection -> paste your DeepSeek API key -> Save."
else
  echo "  2. Nothing - the API key was supplied, ad detection is already on."
fi
echo "  3. Add a podcast library and download an episode."
echo
echo "Transcription is already pointed at the whisper sidecar; detection is"
echo "already pointed at DeepSeek. Budget ~20 min of processing per hour of"
echo "audio. Skipping is client-side, so test on the device you actually use."
