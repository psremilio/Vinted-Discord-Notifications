#!/bin/bash
set -euo pipefail

# — Konfiguration —
PS_API_KEY="${PS_API_KEY:?Env PS_API_KEY fehlt}"
SERVICE_ID="${SERVICE_ID:?Env SERVICE_ID fehlt}"
PROXY_LIST_URL="${PROXY_LIST_URL:-https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all&service=${SERVICE_ID}}"
MAX_PROXY_FAILS="${MAX_PROXY_FAILS:-5}"
LIST_REFRESH_MIN="${LIST_REFRESH_MIN:-180}"
WHITELIST_SLEEP="${WHITELIST_SLEEP:-300}"

# — Railway-Whitelist —
MY_IP=$(curl -fsS https://api64.ipify.org)
curl -fsSL "https://api.proxyscrape.com/v2/account/datacenter_shared/whitelist" \
     --data-urlencode "auth=${PS_API_KEY}" \
     --data-urlencode "service=${SERVICE_ID}" \
     --data-urlencode "ip[]=${MY_IP}"
echo "[proxy] IP $MY_IP whitelisted – warte ${WHITELIST_SLEEP}s"
sleep "$WHITELIST_SLEEP"

# — Proxy-Download mit Backoff —
proxy_fail_count=0
_download_proxies() {
  echo "[proxy] lade Liste …"
  if curl --retry 3 --retry-delay 10 -fsSL "$PROXY_LIST_URL" -o proxies.tmp && [ -s proxies.tmp ]; then
    mv proxies.tmp proxies.txt
    echo "[proxy] $(wc -l < proxies.txt) Proxies gespeichert"
    proxy_fail_count=0
  else
    proxy_fail_count=$((proxy_fail_count+1))
    echo "[proxy] Download FEHLER ($proxy_fail_count/$MAX_PROXY_FAILS)" >&2
    rm -f proxies.tmp
    : > proxies.txt
  fi
}
_download_proxies

(
  while true; do
    sleep $((LIST_REFRESH_MIN*60))
    if [ "$proxy_fail_count" -lt "$MAX_PROXY_FAILS" ]; then
      _download_proxies
    else
      echo "[proxy] Fehlversuchs-Limit erreicht – überspringe Refresh"
    fi
  done
) &

# — Bot starten —
node main.js
