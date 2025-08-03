#!/bin/bash
set -e

MAX_PROXY_FAILS="${MAX_PROXY_FAILS:-5}"     # nach 5 Fehlversuchen kein Sofort-Retry mehr
LIST_REFRESH_MIN="${LIST_REFRESH_MIN:-180}" # 3-stündiger Refresh, falls Env nicht gesetzt
PS_API_KEY="${PS_API_KEY:-}"
PROXY_LIST_URL="${PROXY_LIST_URL:-https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all}"

proxy_fail_count=0
download_proxies() {
  echo "[proxy] lade Liste …"
  if curl --retry 3 --retry-delay 10 -fsSL "$PROXY_LIST_URL" -o proxies.txt && [ -s proxies.txt ]; then
    echo "[proxy] $(wc -l < proxies.txt) Einträge gespeichert"
    proxy_fail_count=0
  else
    proxy_fail_count=$((proxy_fail_count+1))
    echo "[proxy] Download FEHLER ($proxy_fail_count/$MAX_PROXY_FAILS)" >&2
    : > proxies.txt            # leere Datei, Bot läuft ohne Proxy
  fi
}
download_proxies

(
  while true; do
    sleep "$((LIST_REFRESH_MIN*60))"
    if [ "$proxy_fail_count" -lt "$MAX_PROXY_FAILS" ]; then
      download_proxies
    else
      echo "[proxy] Fehlversuchs-Limit erreicht – überspringe Refresh"
      proxy_fail_count=0
    fi
  done
) &

node main.js

