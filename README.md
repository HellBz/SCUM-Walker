# SCUM Walker

**Offline real-time map tracker for SCUM** – Track your position, record routes, and place POIs without leaving the game.

## Features

- **Live Tracking** – Automatically reads your position from SCUM via key simulation
- **Interactive Map** – Leaflet-based offline map with zoom levels 0–6
- **Route Recorder** – Record your paths, color-coded and exportable (JSON/CSV)
- **Road Navigation** – Plan a driving route on the road network; right-click on the live map to set a destination
- **POI Markers** – Place points of interest via right-click or from current position
- **Overlay Mode** – Transparent always-on-top window for OBS/streaming
- **Browser/OBS Integration** – Live-Map URL for browser sources in OBS
- **Hi-Res Tiles** – Optional high-resolution map tiles (zoom 4–6) via in-app download
- **Cross-Platform** – Windows, Linux, and macOS

## Installation

### Download

Grab the latest installer from [Releases](https://github.com/HellBz/SCUM-Walker/releases):

- **Windows**: `.msi` or `.exe` (NSIS installer)
- **Linux**: `.deb` or `.AppImage`
- **macOS**: `.dmg`

After installing, launch the app and click **"⬇ Hi-Res Tiles"** in the sidebar to download high-resolution map tiles for zoom levels 4–6.

### Build from Source

```bash
git clone https://github.com/HellBz/SCUM-Walker.git
cd SCUM-Walker/src-tauri
cargo run
```

Requirements:
- [Rust](https://rustup.rs/)
- [Node.js](https://nodejs.org/) 20+
- On Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`

## Usage

1. Launch SCUM Walker and start SCUM
2. Click **"Live-Tracking starten"** to begin tracking your position
3. Your player marker appears on the map with a directional arrow
4. Right-click the map to place POIs
5. Create routes in the sidebar and record your paths
6. Open the **Overlay** for a transparent map window on top of SCUM/OBS

## Tech Stack

- **Tauri 2.0** (Rust + WebView)
- **Leaflet.js** for map rendering
- **Python** for tile generation

## License

MIT

