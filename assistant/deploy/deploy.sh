#!/usr/bin/env bash
# Build locally and ship the assistant to the Mikrus VPS (ssh alias `mikrus`).
# First run also installs the systemd unit and the nginx site. The API key lives only in
# /etc/jantar-assistant.env on the server (ANTHROPIC_API_KEY=...), never in the repo.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:-mikrus}
DIR=/var/www/jantar-assistant

npm run build
ssh "$HOST" "mkdir -p $DIR"
rsync -az --delete --exclude node_modules --exclude 'server/data' \
  dist server shared src package.json package-lock.json "$HOST:$DIR/"
rsync -az deploy/jantar-assistant.service "$HOST:/etc/systemd/system/jantar-assistant.service"
rsync -az deploy/nginx.conf "$HOST:/etc/nginx/sites-available/jantar-assistant"
ssh "$HOST" bash -s <<REMOTE
set -e
cd $DIR
npm ci --omit=dev --no-audit --no-fund --silent
mkdir -p server/data && chown -R www-data:www-data $DIR
[ -f /etc/jantar-assistant.env ] || { echo 'ANTHROPIC_API_KEY=' > /etc/jantar-assistant.env; chmod 600 /etc/jantar-assistant.env; }
ln -sf /etc/nginx/sites-available/jantar-assistant /etc/nginx/sites-enabled/jantar-assistant
grep -q connection_upgrade /etc/nginx/nginx.conf /etc/nginx/conf.d/*.conf 2>/dev/null || \
  printf 'map \$http_upgrade \$connection_upgrade {\n    default upgrade;\n    %s close;\n}\n' "''" > /etc/nginx/conf.d/connection_upgrade.conf
nginx -t && systemctl reload nginx
systemctl daemon-reload && systemctl enable --now jantar-assistant && systemctl restart jantar-assistant
sleep 1; systemctl --no-pager --lines=3 status jantar-assistant | tail -4
REMOTE
