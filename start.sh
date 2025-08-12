#!/bin/bash
set -euo pipefail

# — Konfiguration —
PS_API_KEY="${PS_API_KEY:-}"
SERVICE_ID="${SERVICE_ID:-}"
PROXY_LIST_URL="${PROXY_LIST_URL:-https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all&service=${SERVICE_ID}}"
MAX_PROXY_FAILS="${MAX_PROXY_FAILS:-5}"
LIST_REFRESH_MIN="${LIST_REFRESH_MIN:-180}"
WHITELIST_SLEEP="${WHITELIST_SLEEP:-300}"

# — Railway-Whitelist —
if [ -n "$PS_API_KEY" ] && [ -n "$SERVICE_ID" ]; then
  MY_IP=$(curl -fsS https://api64.ipify.org)
  curl -fsSL "https://api.proxyscrape.com/v2/account/datacenter_shared/whitelist" \
       --data-urlencode "auth=${PS_API_KEY}" \
       --data-urlencode "service=${SERVICE_ID}" \
       --data-urlencode "ip[]=${MY_IP}"
  echo "[proxy] IP $MY_IP whitelisted – warte ${WHITELIST_SLEEP}s"
  sleep "$WHITELIST_SLEEP"
else
  echo "[proxy] Keine Proxy-Credentials – überspringe Whitelist und verwende direkte Verbindung"
fi

# — Proxy-Download mit Backoff —
mkdir -p config
proxy_fail_count=0
_download_proxies() {
  if [ -z "$PS_API_KEY" ] || [ -z "$SERVICE_ID" ]; then
    echo "[proxy] Keine Credentials – überspringe Proxy-Download, verwende direkte Verbindung"
    : > config/proxies.txt
    return
  fi
  
  echo "[proxy] lade Liste …"
  if curl --retry 3 --retry-delay 10 -fsSL "$PROXY_LIST_URL" -o config/proxies.tmp && [ -s config/proxies.tmp ]; then
    mv config/proxies.tmp config/proxies.txt
    echo "[proxy] $(wc -l < config/proxies.txt) Proxies gespeichert"
    proxy_fail_count=0
  else
    proxy_fail_count=$((proxy_fail_count+1))
    echo "[proxy] Download FEHLER ($proxy_fail_count/$MAX_PROXY_FAILS)" >&2
    rm -f config/proxies.tmp
    : > config/proxies.txt
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
