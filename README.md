# Vinted Discord Notifications Bot

Ein Discord Bot, der Vinted-Suchen überwacht und neue Artikel in Discord-Kanäle postet.

## Features

- 🔍 Automatische Überwachung von Vinted-Suchen
- 📱 Discord-Benachrichtigungen für neue Artikel
- 🔄 Proxy-Rotation für bessere Verfügbarkeit
- ⚡ Konfigurierbare Suchfrequenzen
- 🛡️ Robuste Fehlerbehandlung

## Installation

1. **Repository klonen:**
   ```bash
   git clone <repository-url>
   cd vinted-discord-notifications
   ```

2. **Abhängigkeiten installieren:**
   ```bash
   npm install
   ```

3. **Umgebungsvariablen konfigurieren:**
   ```bash
   cp .env.example .env
   # Bearbeite .env mit deinen Werten
   ```

4. **Bot starten:**
   ```bash
   chmod +x start.sh
   ./start.sh
   ```

## Konfiguration

### Erforderliche Umgebungsvariablen

- `BOT_TOKEN`: Dein Discord Bot Token
- `PS_API_KEY`: ProxyScrape API-Schlüssel
- `SERVICE_ID`: ProxyScrape Service-ID

### Optionale Umgebungsvariablen

- `ALLOW_DIRECT`: Erlaubt direkte Verbindungen ohne Proxies (Standard: 0)
- `PROXY_REFRESH_HOURS`: Proxy-Pool Aktualisierungsintervall (Standard: 6)
- `VINTED_BASE_URL`: Vinted Basis-URL (Standard: https://www.vinted.de/)

## Troubleshooting

### Problem: "No healthy proxies available"

**Symptome:**
- Bot startet nicht
- Fehler in den Logs: "skip initial cookie fetch – no proxy available"
- Wiederholte Fehler: "no proxy available No healthy proxies available"

**Lösungen:**

1. **ProxyScrape-Konfiguration überprüfen:**
   ```bash
   # Stelle sicher, dass diese Variablen gesetzt sind:
   echo $PS_API_KEY
   echo $SERVICE_ID
   ```

2. **IP-Whitelist überprüfen:**
   - Deine Server-IP muss bei ProxyScrape whitelisted sein
   - Das Start-Skript versucht dies automatisch

3. **Direkte Verbindung erlauben (temporär):**
   ```bash
   export ALLOW_DIRECT=1
   ./start.sh
   ```

4. **Proxy-Liste manuell überprüfen:**
   ```bash
   # Schaue dir die geladenen Proxies an:
   cat config/proxies.txt
   
   # Überprüfe die Anzahl:
   wc -l config/proxies.txt
   ```

5. **Proxy-Validierung lockern:**
   - Der Bot versucht automatisch weniger strenge Validierung
   - Überprüfe die Logs für "lockere Validierung" Nachrichten

### Problem: Bot startet, aber Suchen funktionieren nicht

**Symptome:**
- Bot ist online
- Keine Artikel werden gefunden
- Fehler in den Such-Logs

**Lösungen:**

1. **Proxy-Status überprüfen:**
   ```bash
   # Schaue in die Logs:
   tail -f logs/bot.log | grep "proxy"
   ```

2. **Proxy-Pool neu initialisieren:**
   - Der Bot versucht dies automatisch alle 6 Stunden
   - Du kannst es manuell durch Neustart erzwingen

3. **Vinted-Verfügbarkeit testen:**
   ```bash
   curl -I https://www.vinted.de/
   ```

### Problem: Rate Limiting oder IP-Bans

**Symptome:**
- Viele Proxy-Fehler
- "invalid session" Nachrichten
- Bot funktioniert intermittierend

**Lösungen:**

1. **Proxy-Rotation verbessern:**
   - Der Bot rotiert Proxies automatisch
   - Überprüfe, ob genügend Proxies verfügbar sind

2. **Suchfrequenz reduzieren:**
   - Bearbeite `config/channels.json`
   - Erhöhe die `frequency` Werte

3. **Proxy-Qualität verbessern:**
   - Überprüfe dein ProxyScrape-Abonnement
   - Stelle sicher, dass Premium-Proxies aktiviert sind

## Logs verstehen

### Proxy-bezogene Logs

```
[proxy] 1000 Proxies gespeichert          # Proxies erfolgreich geladen
[proxy] Healthy: 5                        # 5 Proxies als gesund validiert
[proxy] 192.168.1.1:8080 ist gesund      # Einzelner Proxy validiert
[proxy] Versuche weniger strenge Validierung...  # Fallback-Validierung
[proxy] 192.168.1.1:8080 akzeptiert (lockere Validierung)  # Proxy akzeptiert
```

### Fehler-Logs

```
[run] skip initial cookie fetch – no proxy available: No healthy proxies available
[search] no proxy available No healthy proxies available
[proxy] 192.168.1.1:8080 als schlecht markiert, verbleibend: 4
```

## Erweiterte Konfiguration

### Proxy-Einstellungen anpassen

```bash
# Proxy-Validierung weniger streng machen
export PROXY_TIMEOUT=15000        # Timeout in ms
export PROXY_MAX_HEALTHY=10       # Maximale Anzahl gesunder Proxies

# Proxy-Refresh häufiger machen
export PROXY_REFRESH_HOURS=2      # Alle 2 Stunden
```

### Fallback-Mechanismen

Der Bot hat mehrere Fallback-Ebenen:

1. **Strenge Proxy-Validierung** (Standard)
2. **Lockere Proxy-Validierung** (über httpbin.org)
3. **Direkte Verbindung** (wenn `ALLOW_DIRECT=1`)
4. **Automatische Proxy-Pool-Erneuerung**

## Support

Bei Problemen:

1. Überprüfe die Logs auf spezifische Fehlermeldungen
2. Stelle sicher, dass alle Umgebungsvariablen korrekt gesetzt sind
3. Teste die ProxyScrape-API manuell
4. Überprüfe deine Discord Bot-Berechtigungen

## Lizenz

Siehe [LICENSE](LICENSE) Datei.
