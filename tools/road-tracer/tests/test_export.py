"""Tests for JSON export and v1-to-v2 migration."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from scum_road_tracer.export import export_to_v2, migrate_v1_to_v2, save_json, load_json
from scum_road_tracer.graph import RoadGraph, GraphNode, GraphEdge


def test_export_v2_format():
    """Export should produce a valid version 2 JSON structure."""
    graph = RoadGraph(
        nodes=[GraphNode(id=0, x=10, y=20, node_type="endpoint")],
        edges=[GraphEdge(id=1, from_node=0, to_node=0, road_type="main", points=[[10, 20], [30, 40]])],
    )
    data = export_to_v2(graph, "test.png", 200, 200, {"main": {"median": 14.0, "accepted_min": 8.0, "accepted_max": 21.0}})
    assert data["format"] == "scum-road-network"
    assert data["version"] == 2
    assert data["image"]["width"] == 200
    assert data["image"]["height"] == 200
    assert len(data["nodes"]) == 1
    assert len(data["roads"]) == 1
    assert data["roads"][0]["type"] == "main"
    assert data["roads"][0]["confidence"] == 1.0
    assert data["roads"][0]["review_required"] == False
    assert data["roads"][0]["synthetic"] == False


def test_v1_migration_basic():
    """V1 format with flat roads array should be migrated to v2."""
    v1_data = {
        "source_image": "map.png",
        "image": {"width": 4096, "height": 4096},
        "coordinate_system": {"origin": "top-left", "point_order": ["x", "y"]},
        "roads": [
            {"id": 1, "type": "main", "points": [[10, 20], [30, 40]], "length_pixels": 28.28},
            {"id": 2, "type": "secondary", "points": [[50, 60], [70, 80]], "length_pixels": 28.28},
        ],
        "rails": [
            {"id": 1, "type": "rail", "points": [[100, 100], [200, 200]]},
        ],
    }
    v2 = migrate_v1_to_v2(v1_data)
    assert v2["format"] == "scum-road-network"
    assert v2["version"] == 2
    assert len(v2["roads"]) == 2, "Rails should be excluded"
    assert all(r["type"] != "rail" for r in v2["roads"])
    assert len(v2["nodes"]) >= 4, "Should have nodes for road endpoints"


def test_v1_migration_mixed_type():
    """V1 'mixed' type should be migrated to 'secondary'."""
    v1_data = {
        "roads": [
            {"id": 1, "type": "mixed", "points": [[10, 20], [30, 40]]},
        ],
    }
    v2 = migrate_v1_to_v2(v1_data)
    assert v2["roads"][0]["type"] == "secondary"


def test_v2_passthrough():
    """Already v2 data should pass through unchanged."""
    v2_data = {
        "format": "scum-road-network",
        "version": 2,
        "source_image": "test.png",
        "image": {"width": 100, "height": 100},
        "coordinate_system": {"origin": "top-left", "point_order": ["x", "y"]},
        "detected_widths": {},
        "nodes": [{"id": 0, "x": 10, "y": 20, "type": "endpoint"}],
        "roads": [{"id": 1, "type": "main", "from": 0, "to": 0, "points": [[10, 20], [30, 40]], "confidence": 0.9, "review_required": False, "synthetic": False}],
        "statistics": {},
        "settings": {},
    }
    result = migrate_v1_to_v2(v2_data)
    assert result is v2_data, "V2 data should pass through unchanged"


def test_json_roundtrip():
    """JSON save and load should roundtrip correctly."""
    graph = RoadGraph(
        nodes=[GraphNode(id=0, x=10, y=20, node_type="endpoint")],
        edges=[GraphEdge(id=1, from_node=0, to_node=0, road_type="main", points=[[10, 20], [30, 40]])],
    )
    data = export_to_v2(graph, "test.png", 200, 200, {})

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "test_roads.json"
        save_json(path, data)
        loaded = load_json(path)

    assert loaded["format"] == data["format"]
    assert loaded["version"] == data["version"]
    assert loaded["roads"] == data["roads"]
    assert loaded["nodes"] == data["nodes"]
