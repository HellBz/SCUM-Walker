# SCUM Road Tracer

Detects yellow main roads and white secondary roads from SCUM map images, exports a versioned road network JSON, and provides a local Leaflet-based editor for manual correction.

## Features

- **Color detection**: HSV + LAB + optional RGB delta-E for yellow and white roads
- **Strict exclusion**: Red rail lines, orange building outlines, and other non-road colors are filtered out
- **Separate processing**: Yellow and white roads are detected and validated independently before merging
- **Width estimation**: Automatic road width detection via distance transform with robust quantiles
- **Centerline extraction**: Skeleton-based centerlines with spur cleanup
- **Graph building**: Nodes (endpoints, junctions) and edges (road segments) with junction clustering
- **Gap bridging**: Endpoint-based connection with tangent direction and pixel support validation
- **Confidence scoring**: Each segment gets a transparent confidence score; low-confidence segments are flagged for review
- **Polyline simplification**: Douglas-Peucker with endpoint and junction preservation
- **Diagnostic images**: Per-stage debug images showing exactly where roads are detected or lost
- **Local editor**: Leaflet-based editor with undo/redo, split/join, review marking, and JSON export

## Requirements

- Windows 10/11
- Python 3.11 or newer

## Installation

1. Run `install.bat` (double-click or command line).
2. Wait for "Installation completed successfully".

## Usage

### Tracing

1. Place map images (PNG/JPG) in the `input/` folder.
2. Run `trace.bat`.
3. Results appear in `output/`.

### Editor

1. Run `start_editor.bat`.
2. Browser opens at `http://localhost:8080/editor/index.html`.
3. Load map image and `roads.json` via the sidebar buttons.
4. Review, edit, and export.

## Output Format (v2)

```json
{
  "format": "scum-road-network",
  "version": 2,
  "source_image": "map.png",
  "image": { "width": 4096, "height": 4096 },
  "coordinate_system": { "origin": "top-left", "point_order": ["x", "y"] },
  "detected_widths": { "main": { "median": 14.2, "accepted_min": 8.5, "accepted_max": 21.0 } },
  "nodes": [{ "id": 0, "x": 100, "y": 200, "type": "endpoint" }],
  "roads": [{ "id": 1, "type": "main", "from": 0, "to": 1, "points": [[100, 200], [120, 210]], "confidence": 0.95, "review_required": false, "synthetic": false }],
  "statistics": {},
  "settings": {}
}
```

## Diagnostic Images

| File | Description |
|------|-------------|
| `*_yellow_raw.png` | Raw yellow mask |
| `*_yellow_clean.png` | Cleaned yellow mask |
| `*_white_raw.png` | Raw white mask |
| `*_white_clean.png` | Cleaned white mask |
| `*_yellow_centerline.png` | Yellow skeleton |
| `*_white_centerline.png` | White skeleton |
| `*_accepted.png` | Accepted segments only |
| `*_review.png` | Review-required and synthetic segments |
| `*_overlay.png` | All segments overlaid on original image |

## Configuration

All settings are in `config.json` with grouped sections:

| Section | Description |
|---------|-------------|
| `input` | Input/output paths, supported extensions |
| `scaling` | Reference resolution for auto-scaling pixel parameters |
| `colors` | HSV/LAB/RGB thresholds for yellow, white, and exclusions |
| `width_detection` | Road width estimation parameters |
| `mask_cleanup` | Morphological operations and component filtering |
| `gap_bridging` | Endpoint gap bridging parameters |
| `graph` | Junction clustering, spur cleanup, edge filtering |
| `confidence` | Confidence scoring weights and thresholds |
| `polyline` | Simplification epsilon, endpoint preservation |
| `debug` | Debug image output, overlay opacity, log level |

## Tests

```bash
.venv\Scripts\python.exe -m pytest tests/ -v
```

## Project Structure

```
road-tracer/
├── scum_road_tracer/     # Python package
│   ├── config.py         # Config loading
│   ├── colors.py         # Color detection (HSV + LAB)
│   ├── masks.py          # Mask cleanup
│   ├── width.py          # Width estimation
│   ├── skeleton.py       # Centerline + spur cleanup
│   ├── graph.py          # Graph building + junction clustering
│   ├── gap_bridge.py     # Endpoint gap bridging
│   ├── simplify.py       # Douglas-Peucker simplification
│   ├── confidence.py     # Confidence scoring
│   ├── export.py         # JSON v2 export + v1 migration
│   ├── diagnostics.py    # Diagnostic images
│   └── pipeline.py       # Main pipeline
├── tests/                # pytest tests with synthetic images
├── editor/               # Leaflet road editor
│   └── index.html
├── config.json
├── requirements.txt
├── install.bat
├── trace.bat
├── start_editor.bat
├── input/                # Place map images here
└── output/               # Results appear here
```

## Known Limitations

- White road detection may include some bright non-road features; use the editor to remove false positives
- Gap bridging works best on clearly aligned segments; complex intersections may need manual review
- Very low resolution images may produce less accurate width estimates
