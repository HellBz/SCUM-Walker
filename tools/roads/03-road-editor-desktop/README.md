# SCUM Road Editor (Desktop)

Native, nicht-webbasierter Editor für SCUM Straßennetze. Läuft mit Python + Tkinter + Pillow.

## Installation

```bash
cd tools\road-editor-desktop
python -m pip install -r requirements.txt
```

Oder einfach doppelklicken auf `start_editor.bat` (versucht, Pillow nachzuinstallieren und startet den Editor).

## Start

```bash
python editor.py
```

oder

```bash
start_editor.bat
```

## Bedienung

1. **Bild laden**: Kartenbild (`scum_map_z6.png` oder ähnliches) öffnen.
2. **JSON laden**: `roads.json` oder `scum_map_roads.json` öffnen.
3. **Navigation**:
   - Mausrad: Zoom
   - Mittlere Maustaste gedrückt halten: Verschieben
4. **Modi** (oben):
   - **Verschieben**: Klick auf Straße/Punkt wählt aus, Ziehen bewegt einen Punkt, Klick+Ziehen in leere Fläche zeichnet ein Lasso.
   - **Neue Straße**: Punkte setzen, `Enter` oder Doppelklick beendet die Linie. Nahe bestehende Punkte werden eingefangen; Klick, Klick auf zwei Punkte erzeugt sofort eine Verbindung.
   - **Punkte bearbeiten**: Klicken und Ziehen verschiebt einzelne Punkte, Klick auf eine Linie fügt einen Gelenkpunkt ein.
5. **Typ ändern**: Ausgewählte Straße(n) auf gelb (`main`), weiß (`secondary`) oder Bahn (`rail`) setzen.
6. **Löschen**: `Entf` oder der Löschen-Button entfernt die Auswahl.
7. **Mehrere Straßen verbinden**: `Strg`+Klick wählt mehrere aus, `Verbinden` fügt sie zu einer Straße zusammen.
8. **Undo / Redo**: `Strg + Z` / `Strg + Y`.
9. **JSON speichern** oder `Strg + S`.

## Unterstützte Formate

- `networks[].roads[]` (wie deine `roads.json`)
- flaches `roads[]` / `rails[]` (wie `scum_map_roads.json`)

Die Datei wird im ursprünglichen Format wieder gespeichert; interne Editor-Keys landen nicht im Output.
