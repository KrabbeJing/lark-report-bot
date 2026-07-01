#!/usr/bin/env bash
set -euo pipefail

: "${DEPLOY_HOST:?Set DEPLOY_HOST, for example: ubuntu@your-server-ip}"

DEPLOY_DIR="${DEPLOY_DIR:-~/lark-report-bot-git}"
DEPLOY_KEY="${DEPLOY_KEY:-}"

ssh_args=(
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)

if [[ -n "$DEPLOY_KEY" ]]; then
  ssh_args+=(-i "$DEPLOY_KEY")
fi

rsync -az --delete \
  -e "ssh ${ssh_args[*]}" \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '*.pem' \
  --exclude 'node_modules/' \
  --exclude 'out/' \
  --exclude '.DS_Store' \
  ./ "$DEPLOY_HOST:$DEPLOY_DIR/"

echo "Synced to $DEPLOY_HOST:$DEPLOY_DIR"
