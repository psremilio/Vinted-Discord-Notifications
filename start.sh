#!/bin/bash
set -euo pipefail

# — Konfiguration —
PS_API_KEY="${PS_API_KEY:?Env PS_API_KEY fehlt}"
SERVICE_ID="${SERVICE_ID:?Env SERVICE_ID fehlt}"
PROXY_LIST_URL="${PROXY_LIST_URL:-https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all&service=${SERVICE_ID}}"
MAX_PROXY_FAILS="${MAX_PROXY_FAILS:-5}"
LIST_REFRESH_MIN="${LIST_REFRESH_MIN:-180}"
WHITELIST_SLEEP="${WHITELIST_SLEEP:-300}"
ALLOW_DIRECT="${ALLOW_DIRECT:-0}"

echo "=== Vinted Discord Bot Start ==="
echo "Proxy-Service: $SERVICE_ID"
echo "Direkte Verbindung erlaubt: $ALLOW_DIRECT"
echo "======================================"

# — Railway-Whitelist —
echo "[proxy] Hole aktuelle IP-Adresse..."
MY_IP=$(curl -fsS --max-time 10 https://api64.ipify.org || echo "unbekannt")
echo "[proxy] Aktuelle IP: $MY_IP"

if [ "$MY_IP" != "unbekannt" ]; then
    echo "[proxy] Whiteliste IP bei ProxyScrape..."
    if curl -fsSL --max-time 30 "https://api.proxyscrape.com/v2/account/datacenter_shared/whitelist" \
         --data-urlencode "auth=${PS_API_KEY}" \
         --data-urlencode "service=${SERVICE_ID}" \
         --data-urlencode "ip[]=${MY_IP}"; then
        echo "[proxy] IP $MY_IP erfolgreich whitelisted"
    else
        echo "[proxy] Warnung: IP Whitelist fehlgeschlagen, aber fahre fort..."
    fi
    echo "[proxy] Warte ${WHITELIST_SLEEP}s nach Whitelist..."
    sleep "$WHITELIST_SLEEP"
else
    echo "[proxy] Warnung: Konnte IP nicht ermitteln, überspringe Whitelist"
fi

# — Proxy-Download mit verbesserter Fehlerbehandlung —
mkdir -p config
proxy_fail_count=0
max_retries=3

_download_proxies() {
    echo "[proxy] Lade Proxy-Liste von ProxyScrape..."
    
    for retry in $(seq 1 $max_retries); do
        echo "[proxy] Versuch $retry/$max_retries..."
        
        if curl --retry 3 --retry-delay 10 --max-time 60 -fsSL "$PROXY_LIST_URL" -o config/proxies.tmp && [ -s config/proxies.tmp ]; then
            # Validate proxy format
            if grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$' config/proxies.tmp > /dev/null; then
                mv config/proxies.tmp config/proxies.txt
                proxy_count=$(wc -l < config/proxies.txt)
                echo "[proxy] ✅ $proxy_count Proxies erfolgreich geladen"
                proxy_fail_count=0
                return 0
            else
                echo "[proxy] ⚠️  Proxy-Liste hat ungültiges Format, versuche erneut..."
                rm -f config/proxies.tmp
            fi
        else
            echo "[proxy] ⚠️  Download fehlgeschlagen (Versuch $retry/$max_retries)"
        fi
        
        if [ $retry -lt $max_retries ]; then
            echo "[proxy] Warte 30s vor erneutem Versuch..."
            sleep 30
        fi
    done
    
    proxy_fail_count=$((proxy_fail_count+1))
    echo "[proxy] ❌ Download nach $max_retries Versuchen fehlgeschlagen ($proxy_fail_count/$MAX_PROXY_FAILS)" >&2
    
    # Create empty proxy file as fallback
    : > config/proxies.txt
    return 1
}

# Initial proxy download
if _download_proxies; then
    echo "[proxy] Proxy-Liste erfolgreich geladen"
else
    echo "[proxy] Initiale Proxy-Liste fehlgeschlagen, aber fahre fort..."
fi

# Background proxy refresh
(
    while true; do
        sleep $((LIST_REFRESH_MIN*60))
        
        if [ "$proxy_fail_count" -lt "$MAX_PROXY_FAILS" ]; then
            echo "[proxy] Aktualisiere Proxy-Liste..."
            if _download_proxies; then
                echo "[proxy] Proxy-Liste erfolgreich aktualisiert"
            else
                echo "[proxy] Proxy-Liste Aktualisierung fehlgeschlagen"
            fi
        else
            echo "[proxy] ⚠️  Fehlversuchs-Limit erreicht – überspringe Refresh"
            echo "[proxy] 💡 Tipp: Überprüfe PS_API_KEY und SERVICE_ID"
        fi
    done
) &

# Wait a bit for initial setup
echo "[proxy] Warte 5s für Proxy-Setup..."
sleep 5

# Check if we have any proxies
if [ -s config/proxies.txt ]; then
    proxy_count=$(wc -l < config/proxies.txt)
    echo "[proxy] 🚀 Starte Bot mit $proxy_count Proxies"
else
    echo "[proxy] ⚠️  Keine Proxies verfügbar"
    if [ "$ALLOW_DIRECT" = "1" ]; then
        echo "[proxy] ✅ Direkte Verbindung erlaubt - Bot wird ohne Proxies laufen"
    else
        echo "[proxy] ❌ Direkte Verbindung nicht erlaubt - Bot wird wahrscheinlich fehlschlagen"
        echo "[proxy] 💡 Setze ALLOW_DIRECT=1 um direkte Verbindung zu erlauben"
    fi
fi

echo "======================================"
echo "Starte Discord Bot..."
echo "======================================"

# — Bot starten —
exec node main.js
