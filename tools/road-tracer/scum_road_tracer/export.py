"""JSON export in version 2 format and migration from version 1.

Version 2 format:
{
  "format": "scum-road-network",
  "version": 2,
  "source_image": "map.png",
  "image": {"width": 4096, "height": 4096},
  "coordinate_system": {"origin": "top-left", "point_order": ["x", "y"]},
  "detected_widths": {},
  "nodes": [],
  "roads": [],
  "statistics": {},
  "settings": {}
}
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .graph import RoadGraph

logger = logging.getLogger(__name__)


def export_to_v2(
    graph: RoadGraph,
    source_image: str,
    image_width: int,
    image_height: int,
    detected_widths: dict[str, dict[str, float]],
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Export the road graph to version 2 JSON format."""
    nodes = [
        {
            "id": n.id,
            "x": n.x,
            "y": n.y,
            "type": n.node_type,
        }
        for n in graph.nodes
    ]

    roads = [
        {
            "id": e.id,
            "type": e.road_type,
            "from": e.from_node,
            "to": e.to_node,
            "points": e.points,
            "confidence": e.confidence,
            "review_required": e.review_required,
            "synthetic": e.synthetic,
            "length_pixels": e.length_pixels,
        }
        for e in graph.edges
    ]

    main_count = sum(1 for r in roads if r["type"] == "main")
    secondary_count = sum(1 for r in roads if r["type"] == "secondary")
    review_count = sum(1 for r in roads if r["review_required"])
    synthetic_count = sum(1 for r in roads if r["synthetic"])

    return {
        "format": "scum-road-network",
        "version": 2,
        "source_image": source_image,
        "image": {
            "width": image_width,
            "height": image_height,
        },
        "coordinate_system": {
            "origin": "top-left",
            "point_order": ["x", "y"],
            "x_direction": "right",
            "y_direction": "down",
        },
        "detected_widths": detected_widths,
        "nodes": nodes,
        "roads": roads,
        "statistics": {
            "node_count": len(nodes),
            "road_count": len(roads),
            "main_count": main_count,
            "secondary_count": secondary_count,
            "review_required_count": review_count,
            "synthetic_count": synthetic_count,
        },
        "settings": settings or {},
    }


def migrate_v1_to_v2(data: dict[str, Any]) -> dict[str, Any]:
    """Migrate a version 1 roads.json to version 2 format.

    Version 1 has flat roads/rails arrays with points.
    Version 2 has nodes and roads with from/to references.
    """
    if data.get("format") == "scum-road-network" and data.get("version", 1) >= 2:
        return data  # Already v2

    old_roads = data.get("roads", [])
    old_rails = data.get("rails", [])

    # Build nodes from road endpoints
    node_map: dict[tuple[int, int], int] = {}
    nodes: list[dict[str, Any]] = []
    next_node_id = 0

    def get_or_create_node(x: int, y: int) -> int:
        nonlocal next_node_id
        key = (x, y)
        if key not in node_map:
            node_map[key] = next_node_id
            nodes.append({
                "id": next_node_id,
                "x": x,
                "y": y,
                "type": "endpoint",
            })
            next_node_id += 1
        return node_map[key]

    roads: list[dict[str, Any]] = []
    for road in old_roads:
        pts = road.get("points", [])
        if len(pts) < 2:
            continue

        road_type = road.get("type", "secondary")
        if road_type == "rail":
            continue  # Skip rails in v2
        if road_type == "mixed":
            road_type = "secondary"

        from_node = get_or_create_node(pts[0][0], pts[0][1])
        to_node = get_or_create_node(pts[-1][0], pts[-1][1])

        roads.append({
            "id": road.get("id", len(roads) + 1),
            "type": road_type,
            "from": from_node,
            "to": to_node,
            "points": pts,
            "confidence": 1.0,
            "review_required": False,
            "synthetic": False,
            "length_pixels": road.get("length_pixels", 0.0),
        })

    # Mark junction nodes (nodes that appear in multiple roads)
    node_usage: dict[int, int] = {}
    for r in roads:
        node_usage[r["from"]] = node_usage.get(r["from"], 0) + 1
        node_usage[r["to"]] = node_usage.get(r["to"], 0) + 1
    for node in nodes:
        if node_usage.get(node["id"], 0) >= 3:
            node["type"] = "junction"
        elif node_usage.get(node["id"], 0) == 2:
            node["type"] = "transition"

    image_info = data.get("image", {})
    return {
        "format": "scum-road-network",
        "version": 2,
        "source_image": data.get("source_image", "unknown"),
        "image": {
            "width": image_info.get("width", 0),
            "height": image_info.get("height", 0),
        },
        "coordinate_system": data.get("coordinate_system", {
            "origin": "top-left",
            "point_order": ["x", "y"],
            "x_direction": "right",
            "y_direction": "down",
        }),
        "detected_widths": {},
        "nodes": nodes,
        "roads": roads,
        "statistics": {
            "node_count": len(nodes),
            "road_count": len(roads),
            "main_count": sum(1 for r in roads if r["type"] == "main"),
            "secondary_count": sum(1 for r in roads if r["type"] == "secondary"),
            "review_required_count": 0,
            "synthetic_count": 0,
        },
        "settings": {},
    }


def save_json(path: Path, data: dict[str, Any]) -> None:
    """Save JSON data to a file with UTF-8 encoding."""
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    logger.info("JSON saved: %s", path)


def load_json(path: Path) -> dict[str, Any]:
    """Load JSON data from a file."""
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)
