#!/bin/bash
set -e

echo "[proxy] lade Liste …"
if curl -fSL "$PROXY_LIST_URL" -o proxies.txt ; then
  echo "[proxy] $(wc -l < proxies.txt) Einträge gespeichert"
else
  echo "[proxy] FEHLER beim Download!" >&2
fi

node main.js  # launch via main entrypoint
