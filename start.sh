#!/bin/bash
set -e

# feste Default-URL, falls ENV leer
PROXY_LIST_URL="${PROXY_LIST_URL:-https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=5aoszl47m6cligu6eq87&type=getproxies&protocol=http&format=txt&status=all&country=all}"

echo "[proxy] lade Liste …"
if curl -fsSL "$PROXY_LIST_URL" -o proxies.txt && [ -s proxies.txt ]; then
  echo "[proxy] $(wc -l < proxies.txt) Einträge gespeichert"
else
  echo "[proxy] kein Proxy – starte ohne" >&2
  : > proxies.txt        # leere Datei anlegen
fi

node main.js  # launch via main entrypoint
