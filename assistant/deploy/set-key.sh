#!/usr/bin/env bash
# Put the Claude API key on the server without it touching the repo or shell history:
#   ./deploy/set-key.sh            (then paste the key and press Enter)
set -euo pipefail
HOST=${HOST:-mikrus}
read -rsp "ANTHROPIC_API_KEY: " KEY; echo
[[ "$KEY" == sk-ant-* ]] || { echo "That does not look like an Anthropic key (sk-ant-...)"; exit 1; }
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" | ssh "$HOST" 'umask 077; cat > /etc/jantar-assistant.env && systemctl restart jantar-assistant && echo "key set, service restarted"'
