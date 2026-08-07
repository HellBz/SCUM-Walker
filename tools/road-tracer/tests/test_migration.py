"""Tests for v1-to-v2 migration specifically."""

from __future__ import annotations

from scum_road_tracer.export import migrate_v1_to_v2


def test_migration_preserves_points():
    """Migration should preserve the original point coordinates."""
    v1 = {
        "roads": [
            {"id": 1, "type": "main", "points": [[10, 20], [30, 40], [50, 60]]},
        ],
    }
    v2 = migrate_v1_to_v2(v1)
    assert v2["roads"][0]["points"] == [[10, 20], [30, 40], [50, 60]]


def test_migration_creates_proper_nodes():
    """Migration should create nodes for road endpoints."""
    v1 = {
        "roads": [
            {"id": 1, "type": "main", "points": [[10, 20], [30, 40]]},
            {"id": 2, "type": "secondary", "points": [[30, 40], [50, 60]]},
        ],
    }
    v2 = migrate_v1_to_v2(v1)
    # 3 unique endpoints: (10,20), (30,40), (50,60)
    assert len(v2["nodes"]) == 3
    # (30,40) is shared between both roads -> should be a transition or junction
    shared = [n for n in v2["nodes"] if n["x"] == 30 and n["y"] == 40]
    assert len(shared) == 1
    assert shared[0]["type"] in ("transition", "junction")


def test_migration_excludes_rails():
    """Rails should not appear in the v2 output."""
    v1 = {
        "roads": [
            {"id": 1, "type": "main", "points": [[10, 20], [30, 40]]},
        ],
        "rails": [
            {"id": 1, "type": "rail", "points": [[100, 100], [200, 200]]},
        ],
    }
    v2 = migrate_v1_to_v2(v1)
    assert all(r["type"] != "rail" for r in v2["roads"])
    assert len(v2["roads"]) == 1


def test_migration_statistics():
    """Migration should compute correct statistics."""
    v1 = {
        "roads": [
            {"id": 1, "type": "main", "points": [[10, 20], [30, 40]]},
            {"id": 2, "type": "secondary", "points": [[30, 40], [50, 60]]},
            {"id": 3, "type": "main", "points": [[50, 60], [70, 80]]},
        ],
    }
    v2 = migrate_v1_to_v2(v1)
    assert v2["statistics"]["main_count"] == 2
    assert v2["statistics"]["secondary_count"] == 1
    assert v2["statistics"]["road_count"] == 3
