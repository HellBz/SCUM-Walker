# Roadmap / Backlog

Offene Themen, die noch nicht umgesetzt sind, sortiert nach Priorität.

## 1. Sprachauswahl (i18n)
Die Sprachauswahl im Settings-Panel existiert bereits als UI-Platzhalter
(`Deutsch (bald verfügbar)` / `English (coming soon)`), ist aber noch
deaktiviert. Es fehlt die eigentliche Übersetzungsinfrastruktur (z. B.
Sprachdateien für DE/EN, Umschalten der UI-Texte zur Laufzeit).

## 2. Dark/Light/System-Theme
Aktuell gibt es nur das bestehende dunkle Design. Geplant: ein Theme-Switch
(Dark / Light / "System") in den Settings, der das Farbschema der App
entsprechend umstellt bzw. das OS-Theme erkennt und automatisch übernimmt.

## 3. POIs mehreren Kategorien zuordnen
Aktuell kann ein POI nur genau einer Kategorie zugeordnet werden
(`category: String` in `src-tauri/src/main.rs`). Wunsch: POIs sollen
mehreren Kategorien gleichzeitig zugeordnet werden können (z. B. als Liste
von Kategorien), inkl. entsprechender Anpassung von Filter, Kategorie-Liste,
Backup-Export/-Import und Anzeige in der Sidebar/Karte.

## 5. Papierkorb / Undo für gelöschte Routen & POIs
Aktuell ist Löschen sofort endgültig (nur per `confirm()`-Dialog
abgesichert). Geplant: gelöschte Routen/POIs erst in einen Papierkorb
verschieben, aus dem sie wiederherstellt oder endgültig entfernt werden
können.

**Offene Frage / wichtig dabei:** Aktuell wird beim Löschen eines POIs
(`remove_poi` in `src-tauri/src/main.rs`) nur der Datensatz entfernt – das
zugehörige Bild (z. B. bei Auto-POI-Screenshots) bleibt als verwaiste Datei
in `poi_images/` liegen und wird nie gelöscht. Im Zuge des Papierkorbs
sollte das Bild solange erhalten bleiben, bis der POI endgültig aus dem
Papierkorb entfernt wird (erst dann Bilddatei löschen) – sonst sammeln sich
dauerhaft ungenutzte Bilder an.

## 7. Mehrere Wegpunkte in der Navigation
Aktuell unterstützt der Navigationsmodus nur genau einen Start- und
Zielpunkt. Erweiterung: mehrere Zwischenpunkte (Waypoints) per Rechtsklick
hinzufügen können; die Route wird durch alle Punkte in Reihenfolge berechnet,
inkl. Gesamtdistanz/ETA. Nützlich für Touren mit mehreren Stopps.

## 8. Unit-Tests für Backup-Import/Export
Da der Import (`import_full_backup`, `import_routes_backup`,
`import_pois_backup`, `import_settings_backup`) direkt Nutzerdaten
überschreibt bzw. ergänzt, sollten dafür Rust-Unit-Tests existieren,
die valide/ungültige Backup-Dateien und Kategorie-Filter abdecken.

## 9. Auto-Update für Linux/macOS (niedrige Priorität)
Der Release-Workflow erzeugt aktuell nur für Windows ein `updater.json`
(`includeUpdaterJson`). Da das Live-Tracking ohnehin auf Windows-APIs
angewiesen ist (Fenster-Handle-Erkennung) und SCUM primär ein
Windows-Spiel ist, ist das für Linux/macOS nicht dringend – aber ggf.
sinnvoll für Nutzer, die die App nur zur offline Karten-/Routenplanung
verwenden.

## 10. Vordefinierte Marker/POI-Packs (Import)
Kuratierte POI-Sets (z. B. Bunker, Trader, Polizeistationen) sollen sich
importieren lassen, entweder direkt im Release gebündelt oder remote
nachladbar. Für die Remote-Variante: separates Content-Repo (analog zu den
Hi-Res-Tiles), das per GitHub-Release-Assets sowohl Tiles als auch mehrere
POI-Pack-ZIPs bereitstellt, plus einen kleinen Index (`poi-packs/index.json`)
mit Name/Beschreibung/Anzahl pro Pack. Die App lädt den Index, zeigt eine
Auswahl an und importiert das gewählte Pack über die bestehende
ZIP-Import-Logik (Quelle dann URL statt lokale Datei). Zusätzlich 1-2
Standard-Packs im Installer bündeln als Offline-Fallback.

## Erledigt
- **POI-Suche** – Textfeld in der POI-Sidebar filtert nach Name und Kategorie und zentriert die Karte auf den gewählten Treffer.
- **Automatisches Rotations-Backup** – Beim Start und nach Änderungen (höchstens alle 10 Minuten) wird `scum_walker_data.json` gesichert, die letzten 5 unterschiedlichen Stände bleiben erhalten.
- **Pause/Resume-Hotkey** – F8 pausiert das Live-Tracking, ohne die aufgezeichnete Route zu verwerfen (Issue #4).

## Verworfen
- **GPX/KML-Export von Routen** – ergibt keinen Sinn, da SCUM-Koordinaten
  spielinterne X/Y-Werte und keine echten GPS-Koordinaten sind.
