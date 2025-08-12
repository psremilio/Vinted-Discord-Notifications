#!/bin/bash

echo "=== Vinted Discord Bot - Proxy Debug Tool ==="
echo ""

# Check environment variables
echo "🔍 Überprüfe Umgebungsvariablen..."
if [ -z "$PS_API_KEY" ]; then
    echo "❌ PS_API_KEY ist nicht gesetzt"
    exit 1
else
    echo "✅ PS_API_KEY ist gesetzt"
fi

if [ -z "$SERVICE_ID" ]; then
    echo "❌ SERVICE_ID ist nicht gesetzt"
    exit 1
else
    echo "✅ SERVICE_ID ist gesetzt"
fi

echo ""

# Check current IP
echo "🌐 Aktuelle IP-Adresse..."
MY_IP=$(curl -fsS --max-time 10 https://api64.ipify.org || echo "unbekannt")
echo "IP: $MY_IP"

if [ "$MY_IP" != "unbekannt" ]; then
    echo "✅ IP-Adresse erfolgreich ermittelt"
else
    echo "⚠️  Konnte IP-Adresse nicht ermitteln"
fi

echo ""

# Test ProxyScrape API
echo "🔑 Teste ProxyScrape API..."
PROXY_LIST_URL="https://api.proxyscrape.com/v2/account/datacenter_shared/proxy-list?auth=${PS_API_KEY}&type=getproxies&protocol=http&format=txt&status=all&country=all&service=${SERVICE_ID}"

echo "URL: $PROXY_LIST_URL"

# Test API response
if curl -fsSL --max-time 30 "$PROXY_LIST_URL" -o /tmp/test_proxies.txt; then
    PROXY_COUNT=$(wc -l < /tmp/test_proxies.txt)
    echo "✅ API funktioniert - $PROXY_COUNT Proxies erhalten"
    
    # Show first few proxies
    echo "Erste 5 Proxies:"
    head -5 /tmp/test_proxies.txt | sed 's/^/  /'
    
    # Validate proxy format
    INVALID_COUNT=$(grep -v -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+$' /tmp/test_proxies.txt | wc -l)
    if [ "$INVALID_COUNT" -eq 0 ]; then
        echo "✅ Alle Proxies haben gültiges Format"
    else
        echo "⚠️  $INVALID_COUNT Proxies haben ungültiges Format"
    fi
else
    echo "❌ API-Test fehlgeschlagen"
    echo "Mögliche Ursachen:"
    echo "  - Ungültiger API-Schlüssel"
    echo "  - Ungültige Service-ID"
    echo "  - API-Limit erreicht"
    echo "  - Netzwerkproblem"
fi

rm -f /tmp/test_proxies.txt

echo ""

# Check existing proxy file
echo "📁 Überprüfe existierende Proxy-Datei..."
if [ -f "config/proxies.txt" ]; then
    EXISTING_COUNT=$(wc -l < config/proxies.txt)
    echo "✅ config/proxies.txt existiert mit $EXISTING_COUNT Proxies"
    
    if [ "$EXISTING_COUNT" -gt 0 ]; then
        echo "Erste 3 Proxies:"
        head -3 config/proxies.txt | sed 's/^/  /'
    fi
else
    echo "❌ config/proxies.txt existiert nicht"
fi

echo ""

# Test individual proxy
echo "🧪 Teste einzelne Proxies..."
if [ -f "config/proxies.txt" ] && [ -s "config/proxies.txt" ]; then
    TEST_PROXY=$(head -1 config/proxies.txt)
    if [ -n "$TEST_PROXY" ]; then
        echo "Teste Proxy: $TEST_PROXY"
        
        # Parse proxy
        HOST=$(echo "$TEST_PROXY" | cut -d: -f1)
        PORT=$(echo "$TEST_PROXY" | cut -d: -f2)
        
        echo "Host: $HOST, Port: $PORT"
        
        # Test connection
        if timeout 10 bash -c "</dev/tcp/$HOST/$PORT" 2>/dev/null; then
            echo "✅ Proxy $TEST_PROXY ist erreichbar"
        else
            echo "❌ Proxy $TEST_PROXY ist nicht erreichbar"
        fi
        
        # Test with curl
        echo "Teste HTTP-Request über Proxy..."
        if curl -fsSL --max-time 10 --proxy "http://$TEST_PROXY" "http://httpbin.org/ip" > /dev/null 2>&1; then
            echo "✅ Proxy $TEST_PROXY funktioniert für HTTP-Requests"
        else
            echo "❌ Proxy $TEST_PROXY funktioniert nicht für HTTP-Requests"
        fi
    fi
else
    echo "⚠️  Keine Proxies zum Testen verfügbar"
fi

echo ""

# Check network connectivity
echo "🌐 Überprüfe Netzwerkverbindung..."
if curl -fsSL --max-time 10 "https://www.vinted.de/" > /dev/null 2>&1; then
    echo "✅ Direkte Verbindung zu Vinted funktioniert"
else
    echo "❌ Direkte Verbindung zu Vinted funktioniert nicht"
fi

if curl -fsSL --max-time 10 "http://httpbin.org/ip" > /dev/null 2>&1; then
    echo "✅ Direkte Verbindung zu httpbin.org funktioniert"
else
    echo "❌ Direkte Verbindung zu httpbin.org funktioniert nicht"
fi

echo ""

# Recommendations
echo "💡 Empfehlungen:"
echo ""

if [ "$ALLOW_DIRECT" = "1" ]; then
    echo "✅ ALLOW_DIRECT=1 ist gesetzt - Bot kann ohne Proxies laufen"
else
    echo "⚠️  ALLOW_DIRECT=0 - Bot benötigt funktionierende Proxies"
    echo "   Setze ALLOW_DIRECT=1 für direkte Verbindung"
fi

echo ""
echo "🔧 Nächste Schritte:"
echo "1. Überprüfe deine ProxyScrape-Konfiguration"
echo "2. Stelle sicher, dass deine IP whitelisted ist"
echo "3. Teste den Bot mit: ./start.sh"
echo "4. Überprüfe die Logs auf spezifische Fehler"
echo "5. Bei Problemen: export ALLOW_DIRECT=1 && ./start.sh"

echo ""
echo "=== Debug abgeschlossen ==="