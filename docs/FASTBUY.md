# Fastbuy (Quickfix)

Fastbuy ergänzt im Discord-Post einen zusätzlichen Button, der die Vinted-Item-Seite mit dem Parameter `?fastbuy=1` öffnet. Ein Tampermonkey-Userscript klickt auf der Item-Seite automatisch auf „Kaufen“, sodass du direkt im Checkout landest. Es findet kein Auto-Pay statt.

Installation (Tampermonkey)
- Browser-Erweiterung Tampermonkey installieren (Chrome/Firefox).
- In Tampermonkey „Neues Skript“ anlegen, Inhalt aus `userscripts/vinted_fastbuy.user.js` aus diesem Repo kopieren und einfügen, speichern.
- Eingeloggt bei Vinted sein. Klicke im Discord auf „FASTBUY“ und folge dem Checkout.

Hinweise
- Funktioniert auf Domains wie `vinted.de`, `vinted.fr` etc. durch `@match https://www.vinted.*/*`.
- Der Button hängt `?fastbuy=1` bzw. `&fastbuy=1` an bestehende URLs an.

