# SCUM Road Tracer

Erkennt gelbe Hauptstraßen und weiße Nebenstraßen auf SCUM-Kartenbildern, exportiert ein versioniertes Straßennetz als JSON und bietet einen lokalen Leaflet-Editor zur manuellen Korrektur.

## Funktionen

- **Farberkennung**: HSV + LAB + optionaler RGB Delta-E für gelbe und weiße Straßen
- **Strikte Ausschlüsse**: Rote Bahnlinien, orange Gebäudeumrisse und andere Nicht-Straßen-Farben werden gefiltert
- **Getrennte Verarbeitung**: Gelb und Weiß werden unabhängig erkannt und validiert
- **Breitenschätzung**: Automatische Straßenzbreitenerkennung über Distance Transform
- **Mittellinien**: Skeleton-basierte Mittellinien mit Spur-Bereinigung
- **Graphenaufbau**: Knoten (Endpunkte, Kreuzungen) und Kanten (Straßensegmente) mit Kreuzungs-Clustering
- **Lückenüberbrückung**: Endpunkt-basierte Verbindung mit Richtungs- und Pixel-Support-Prüfung
- **Konfidenz-Score**: Jedes Segment erhält einen nachvollziehbaren Konfidenzwert; unsichere Segmente werden markiert
- **Polyline-Vereinfachung**: Douglas-Peucker mit Erhaltung von Endpunkten und Kreuzungen
- **Diagnosebilder**: Pro-Stage Debug-Bilder zeigen genau, wo Straßen erkannt oder verloren werden
- **Lokaler Editor**: Leaflet-Editor mit Undo/Redo, Teilen/Verbinden, Review-Markierung und JSON-Export

## Voraussetzungen

- Windows 10/11
- Python 3.11 oder neuer

## Installation

1. `install.bat` doppelklicken.
2. Warten bis "Installation completed successfully" erscheint.

## Benutzung

### Tracer starten

1. Kartenbilder (PNG/JPG) in den Ordner `input` kopieren.
2. `trace.bat` doppelklicken.
3. Ergebnisse erscheinen im Ordner `output`.

### Editor starten

1. `start_editor.bat` doppelklicken.
2. Browser öffnet sich automatisch.
3. Kartenbild und `roads.json` über die Sidebar laden.
4. Überprüfen, bearbeiten und exportieren.

## Ausgabeformat (v2)

```json
{
  "format": "scum-road-network",
  "version": 2,
  "roads": [{ "id": 1, "type": "main", "points": [[100, 200], [120, 210]], "confidence": 0.95, "review_required": false }]
}
```

Unterstützte Typen: `main`, `secondary` (keine Rails).

## Diagnosebilder

- `*_overlay.png` – Alle Segmente über dem Original
- `*_accepted.png` – Nur akzeptierte Segmente
- `*_review.png` – Review-pflichtige und synthetische Segmente
- `*_yellow_raw.png` / `*_yellow_clean.png` – Gelb-Masken
- `*_white_raw.png` / `*_white_clean.png` – Weiß-Masken
- `*_yellow_centerline.png` / `*_white_centerline.png` – Mittellinien

## Konfiguration

Alle Werte in `config.json` mit gruppierten Bereichen: `input`, `scaling`, `colors`, `width_detection`, `mask_cleanup`, `gap_bridging`, `graph`, `confidence`, `polyline`, `debug`.

## Tests

```bash
.venv\Scripts\python.exe -m pytest tests/ -v
```

## Bekannte Grenzen

- Weiße Straßenerkennung kann helle Nicht-Straßen-Features enthalten; im Editor entfernen
- Lückenüberbrückung funktioniert am besten bei klar ausgerichteten Segmenten
- Sehr niedrig aufgelöste Bilder können ungenauere Breitenschätzungen liefern
