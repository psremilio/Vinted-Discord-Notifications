#!/usr/bin/env bash
set -e

# ------------------ feste Konstanten ------------------
PS_API_KEY="5aoszl47m6cligu6eq87"
PROXY_LIST_URL="https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=5aoszl47m6cligu6eq87&type=getproxies&protocol=http&format=txt&status=all&country=all"

WHITELIST_SLEEP="${WHITELIST_SLEEP:-300}"   # 5 Min Wartezeit
LIST_REFRESH_MIN="${LIST_REFRESH_MIN:-60}"  # 60 Min Refresh
# ------------------------------------------------------

MY_IP=$(curl -s https://api64.ipify.org)
curl -sG "https://api.proxyscrape.com/v2/account/datacenter_shared/whitelist" \
     --data-urlencode "auth=${PS_API_KEY}" \
     --data-urlencode "type=set" \
     --data-urlencode "ip[]=${MY_IP}"
echo "[proxy] IP ${MY_IP} auf Whitelist gesetzt – warte ${WHITELIST_SLEEP}s"
sleep "${WHITELIST_SLEEP}"

echo "[proxy] lade Liste …"
if curl -fSL "${PROXY_LIST_URL}" -o proxies.txt ; then
  echo "[proxy] $(wc -l < proxies.txt) Einträge gespeichert"
else
  echo "[proxy] FEHLER beim Download – starte ohne Proxy" >&2
  : > proxies.txt
fi

( while true; do
      sleep "$((LIST_REFRESH_MIN*60))"
      echo "[proxy] Refresh …"
      curl -sSL "${PROXY_LIST_URL}" -o proxies.txt && \
      echo "[proxy] $(wc -l < proxies.txt) Einträge gespeichert"
  done ) &
REFRESH_PID=$!

node index.js
EXIT_CODE=$?
kill "${REFRESH_PID}" 2>/dev/null || true
exit "${EXIT_CODE}"
