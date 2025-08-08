#!/bin/bash
set -euo pipefail

# — Konfiguration —
PS_API_KEY="${PS_API_KEY:?Env PS_API_KEY fehlt}"

WHITELIST_SLEEP="${WHITELIST_SLEEP:-60}"
MAX_PROXY_FAILS="${MAX_PROXY_FAILS:-5}"
LIST_REFRESH_MIN="${LIST_REFRESH_MIN:-180}"
PROXY_LIST_URL="https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all"

# — Railway-Whitelist —
MY_IP=$(curl -fsS https://api64.ipify.org)
curl -sG "https://api.proxyscrape.com/v2/account/datacenter_shared/whitelist" \
     --data-urlencode "auth=${PS_API_KEY}" \
     --data-urlencode "type=set" \
     --data-urlencode "ip[]=${MY_IP}"

echo "[proxy] IP $MY_IP whitelisted – warte ${WHITELIST_SLEEP}s"
sleep "$WHITELIST_SLEEP"

# — Proxy-Download mit Backoff —
proxy_fail_count=0
_download_proxies() {
  echo "[proxy] lade Liste …"
  if [ -z "$PROXY_LIST_URL" ]; then
    echo "[proxy] keine PROXY_LIST_URL – überspringe Download" >&2
    : > proxies.txt
    return
  fi
  if curl --retry 3 --retry-delay 10 -fsSL "$PROXY_LIST_URL" -o proxies.txt && [ -s proxies.txt ]; then
    echo "[proxy] $(wc -l < proxies.txt) Proxies gespeichert"
    proxy_fail_count=0
  else
    proxy_fail_count=$((proxy_fail_count+1))
    echo "[proxy] Download FEHLER ($proxy_fail_count/$MAX_PROXY_FAILS)" >&2
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
