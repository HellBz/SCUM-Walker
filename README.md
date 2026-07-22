# SCUM Walker (Tauri)

Tauri-basierte Karten-App für SCUM. Drückt automatisch `Strg+C`, liest die Zwischenablage und zeichnet den Weg auf die SCUM-Karte.

## Voraussetzungen

- Rust + Cargo
- Windows

## Installation

1. SCUM-Kartenbild in den `src`-Ordner kopieren:

```bash
copy "C:\Users\stefa\Documents\Downloads\nerdmaps-for-scum-main\nerdmaps-for-scum-main\nerdmaps-for-scum-LATEST\scum_map-1080x1080.png" "C:\Users\stefa\CascadeProjects\scum-walker-tauri\src\scum_map-1080x1080.png"
```

2. App bauen und starten:

```bash
cd C:\Users\stefa\CascadeProjects\scum-walker-tauri\src-tauri
cargo run
```

## Bedienung

- App starten und SCUM im Fokus halten.
- Alle 10 Sekunden wird `Strg+C` gedrückt und die Position aufgezeichnet.
- Rechtsklick auf die Karte setzt einen POI.
- Route löschen über die Seitenleiste.
