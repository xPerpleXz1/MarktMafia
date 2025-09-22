# 🤖 GTA V Grand RP Strandmarkt Bot

Ein Discord Bot zur Verwaltung von Strandmarktpreisen für GTA V Grand RP DE1 Server.

[![Discord.js](https://img.shields.io/badge/discord.js-v14-blue)](https://discord.js.org/)
[![Node.js](https://img.shields.io/badge/node.js-v18+-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

## 🎯 Features

- **💰 Preise verwalten**: Marktpreise und Staatswerte eintragen und aktualisieren
- **📊 Preisverlauf**: Komplette Historie aller Preisänderungen mit interaktiven Diagrammen
- **📈 Statistiken**: Durchschnittspreise, Min/Max-Werte und Gewinn-Analysen
- **🔍 Auto-Complete**: Intelligente Vorschläge für bereits eingetragene Artikel
- **🖼️ Bilder**: Optionale Bilder zu Gegenständen hinzufügen
- **🏛️ Staatswerte**: Vergleich zwischen Marktpreisen und offiziellen NPC-Preisen
- **💾 Datenschutz**: Alle Daten bleiben auf deinem Server - keine externen Services

## 🚀 Quick Start

### 1. Discord Bot erstellen
1. Gehe zu [Discord Developer Portal](https://discord.com/developers/applications)
2. Erstelle eine neue Application
3. Gehe zu "Bot" → "Add Bot"
4. Aktiviere "Message Content Intent"
5. Kopiere den Bot Token

### 2. Bot einladen
1. Gehe zu "OAuth2" → "URL Generator"  
2. Wähle Scopes: `bot` + `applications.commands`
3. Wähle Permissions:
   - Send Messages
   - Use Slash Commands
   - Embed Links  
   - Attach Files
   - Read Message History
4. Verwende die generierte URL um den Bot einzuladen

### 3. Cloud Deployment (Empfohlen)

#### Railway (Kostenlos & Einfach)
1. Erstelle ein [Railway](https://railway.app) Konto
2. Fork dieses Repository oder lade es hoch
3. Verbinde Railway mit deinem GitHub Repository
4. Füge Environment Variable hinzu: `DISCORD_TOKEN=dein_bot_token`
5. Deploy! 🚀

#### Alternative Cloud-Anbieter
- **Heroku**: Kostenloser Tier verfügbar
- **Google Cloud Run**: Pay-per-use
- **DigitalOcean App Platform**: $5/Monat
- **Render.com**: Kostenloser Tier

### 4. Lokale Installation

```bash
# Repository klonen
git clone https://github.com/dein-username/gta-strandmarkt-bot.git
cd gta-strandmarkt-bot

# Dependencies installieren
npm install

# Environment Variables konfigurieren
cp .env.example .env
# Bearbeite .env und füge deinen Discord Token hinzu

# Bot starten
npm start
```

## 🎮 Commands

### `/preis-hinzufugen`
Neuen Preis hinzufügen oder bestehenden aktualisieren
- **Gegenstand**: Name des Items (z.B. "AK-47")
- **Marktpreis**: Aktueller Handelspreis zwischen Spielern
- **Staatswert**: Offizieller NPC-Preis (optional)
- **Bild**: URL zu einem Bild (optional)

**Besonderheit**: Bestehende Werte (Staatswert, Bild) werden beibehalten wenn du sie nicht neu angibst!

### `/preis-anzeigen <gegenstand>`
Aktuellen Preis eines Gegenstands anzeigen mit:
- Marktpreis und Staatswert
- Gewinn/Verlust-Berechnung
- Letzte Aktualisierung

### `/alle-preise`
Alle gespeicherten Preise anzeigen:
- Sortiert nach Marktpreis (höchste zuerst)
- Top 3 Items erhalten Medaillen 🥇🥈🥉
- Zeigt Marktpreis und Staatswert

### `/preis-verlauf <gegenstand>`
Preisverlauf mit interaktivem Diagramm:
- Orange Linie: Marktpreis-Entwicklung
- Grüne Linie: Staatswert-Entwicklung (falls verfügbar)
- Statistiken zu höchstem/niedrigstem Preis

### `/durchschnittspreis <gegenstand>`
Detaillierte Statistiken:
- Durchschnittspreise für Markt und Staat
- Min/Max-Werte und Schwankungsbreite
- Durchschnittlicher Gewinn in € und %

## 🗄️ Datenbank

Der Bot verwendet SQLite für lokale Datenspeicherung:
- **current_prices**: Aktuelle Preise (überschreibbar)
- **price_history**: Komplette Historie aller Änderungen
- **Automatische Migration**: Alte Daten bleiben bei Updates erhalten

### Datenbank-Schema

```sql
-- Aktuelle Preise
CREATE TABLE current_prices (
    id INTEGER PRIMARY KEY,
    item_name TEXT UNIQUE,      -- Suchbarer Name (lowercase)
    display_name TEXT,          -- Anzeigename (mit Groß-/Kleinschreibung)
    market_price REAL,          -- Marktpreis
    state_value REAL,           -- Staatswert (optional)
    image_url TEXT,             -- Bild-URL (optional)
    last_updated DATETIME,      -- Letzte Änderung
    updated_by TEXT             -- Wer hat aktualisiert
);

-- Preis-Historie
CREATE TABLE price_history (
    id INTEGER PRIMARY KEY,
    item_name TEXT,
    display_name TEXT,
    market_price REAL,
    state_value REAL,
    image_url TEXT,
    date_added DATETIME,
    added_by TEXT
);
```

## 🔧 Konfiguration

### Environment Variables
```bash
# Erforderlich
DISCORD_TOKEN=dein_discord_bot_token

# Optional
DATABASE_PATH=./strandmarkt.db  # Pfad zur Datenbank
PORT=3000                       # Port für Health Checks
```

### Docker
```bash
# Mit Docker Compose
docker-compose up -d

# Logs anzeigen
docker-compose logs -f

# Stoppen
docker-compose down
```

## 📈 Beispiele

### Preis hinzufügen mit Auto-Complete
```
/preis-hinzufugen
Gegenstand: AK-4  → Vorschlag: "AK-47"
Marktpreis: 15000
Staatswert: 8500
```

### Ergebnis:
```
✅ Preis erfolgreich aktualisiert!
📦 Gegenstand: AK-47
💰 Marktpreis: 15.000 €
🏛️ Staatswert: 8.500 €
📈 Gewinn/Verlust: 6.500 € (76.5%)
ℹ️ Status: 🔄 Bestehender Eintrag aktualisiert
```

### Nur Marktpreis aktualisieren (Staatswert bleibt erhalten):
```
/preis-hinzufugen
Gegenstand: AK-47
Marktpreis: 16000
# Staatswert nicht angegeben = alter Wert bleibt!
```

## 🤝 Contributing

1. Fork das Repository
2. Erstelle einen Feature Branch (`git checkout -b feature/neue-funktion`)
3. Committe deine Änderungen (`git commit -am 'Neue Funktion hinzugefügt'`)
4. Push zum Branch (`git push origin feature/neue-funktion`)
5. Erstelle eine Pull Request

## 📋 Roadmap

- [ ] **Multi-Server Support**: Separate Datenbanken pro Discord Server
- [ ] **Benachrichtigungen**: Auto-Alerts bei großen Preisänderungen
- [ ] **Export/Import**: CSV/Excel Export der Datenbank
- [ ] **Admin Commands**: Daten löschen und bearbeiten
- [ ] **REST API**: Externe Zugriffe auf die Preisdaten
- [ ] **Backup System**: Automatische Cloud-Backups
- [ ] **Price Alerts**: Benachrichtigungen bei Zielpreisen
- [ ] **Kategorien**: Items in Kategorien gruppieren (Waffen, Autos, etc.)

## 🚨 Troubleshooting

### Bot antwortet nicht
- ✅ Bot Token korrekt in Environment Variables?
- ✅ Bot hat die richtigen Permissions auf dem Server?
- ✅ Slash Commands können bis zu 1 Stunde brauchen für Registrierung

### Diagramme werden nicht angezeigt
- ✅ Chart-Dependencies korrekt installiert?
- ✅ Bot zeigt automatisch Text-Fallback an
- ✅ Bei Cloud-Deployment: Ausreichend Speicher?

### Datenbank-Probleme
- ✅ SQLite-Datei hat Schreibrechte?
- ✅ Bei Cloud: Persistenter Storage konfiguriert?
- ✅ Migration-Logs in der Konsole prüfen

### Auto-Complete funktioniert nicht
- ✅ Mindestens ein Artikel muss eingetragen sein
- ✅ Discord kann 1-2 Minuten brauchen für Updates
- ✅ Groß-/Kleinschreibung ist egal

## 📊 Performance

- **Datenbank**: SQLite - bis zu 100.000 Einträge problemlos
- **Memory**: ~50-100MB RAM je nach Anzahl Charts
- **CPU**: Minimal - nur aktiv bei Commands
- **Storage**: ~10MB für 1000 Preiseinträge mit Bildern

## 🛡️ Sicherheit

- **Keine externen APIs**: Alle Daten bleiben auf deinem Server
- **Kein Internet-Zugriff nötig**: Funktioniert komplett offline
- **Discord Permissions**: Minimale Rechte erforderlich
- **Open Source**: Code ist komplett einsehbar

## 📞 Support

- **GitHub Issues**: [Issues erstellen](https://github.com/dein-username/gta-strandmarkt-bot/issues)
- **Diskussionen**: [GitHub Discussions](https://github.com/dein-username/gta-strandmarkt-bot/discussions)
- **Discord**: [Support Server](https://discord.gg/dein-server)

## 🙏 Credits

- **Discord.js**: Für die Discord-Integration
- **Chart.js**: Für die schönen Diagramme
- **SQLite**: Für die zuverlässige Datenbank
- **Railway**: Für kostenloses Cloud-Hosting

## ⭐ Star History

Wenn dir dieser Bot gefällt, gib ihm einen Stern! ⭐

---

**Gemacht mit ❤️ für die GTA V Grand RP Community**
