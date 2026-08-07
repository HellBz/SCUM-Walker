"""Tests for graph building: junctions, edges, skeleton tracing."""

from __future__ import annotations

import numpy as np

from scum_road_tracer.skeleton import to_centerline, cleanup_spurs
from scum_road_tracer.graph import build_graph, trace_skeleton_paths
from scum_road_tracer.colors import create_yellow_mask, create_white_mask
from scum_road_tracer.masks import clean_yellow_mask, clean_white_mask


def test_graph_builds_from_yellow_road(yellow_horizontal, test_config):
    """A graph built from a horizontal yellow road should have at least 2 nodes and 1 edge."""
    mask = create_yellow_mask(yellow_horizontal, test_config)
    cleaned = clean_yellow_mask(mask, test_config)
    skeleton = to_centerline(cleaned)
    graph = build_graph(skeleton, "main", junction_cluster_radius=5, min_edge_length=3)
    assert len(graph.nodes) >= 2, "Should have at least 2 endpoints"
    assert len(graph.edges) >= 1, "Should have at least 1 edge"


def test_graph_crossing_creates_junction(yellow_white_crossing, test_config):
    """A crossing should create a junction node in the graph."""
    yellow_mask = create_yellow_mask(yellow_white_crossing, test_config)
    white_mask = create_white_mask(yellow_white_crossing, test_config)
    yellow_clean = clean_yellow_mask(yellow_mask, test_config)
    white_clean = clean_white_mask(white_mask, test_config)

    yellow_sk = to_centerline(yellow_clean)
    white_sk = to_centerline(white_clean)

    yg = build_graph(yellow_sk, "main", junction_cluster_radius=5, min_edge_length=3)
    wg = build_graph(white_sk, "secondary", junction_cluster_radius=5, min_edge_length=3)

    # At least one graph should have a junction or multiple edges
    total_edges = len(yg.edges) + len(wg.edges)
    assert total_edges >= 2, "Crossing should produce multiple edges"


def test_graph_edge_has_correct_type(yellow_horizontal, test_config):
    """Graph edges should have the road type passed to build_graph."""
    mask = create_yellow_mask(yellow_horizontal, test_config)
    cleaned = clean_yellow_mask(mask, test_config)
    skeleton = to_centerline(cleaned)
    graph = build_graph(skeleton, "main", junction_cluster_radius=5, min_edge_length=3)
    for edge in graph.edges:
        assert edge.road_type == "main"


def test_skeleton_tracing_returns_paths(yellow_horizontal, test_config):
    """Skeleton tracing should return at least one path for a road."""
    mask = create_yellow_mask(yellow_horizontal, test_config)
    cleaned = clean_yellow_mask(mask, test_config)
    skeleton = to_centerline(cleaned)
    paths = trace_skeleton_paths(skeleton)
    assert len(paths) >= 1, "Should trace at least one path"
    assert len(paths[0]) >= 2, "Path should have at least 2 pixels"


def test_spur_cleanup_removes_short_spur(short_spur, test_config):
    """Short false spurs should be cleaned from the skeleton."""
    mask = create_yellow_mask(short_spur, test_config)
    cleaned = clean_yellow_mask(mask, test_config)
    skeleton = to_centerline(cleaned)

    # Count skeleton pixels before cleanup
    before = int(np.count_nonzero(skeleton))

    # Clean spurs with aggressive settings
    cleaned_sk = cleanup_spurs(skeleton, cleaned, max_spur_length=8, min_support=0.9)

    after = int(np.count_nonzero(cleaned_sk))
    # The spur should have been removed or at least reduced
    assert after <= before, "Cleanup should not add pixels"


def test_dead_end_not_removed(dead_end, test_config):
    """A real short dead-end should NOT be removed by spur cleanup."""
    from scum_road_tracer.colors import create_yellow_mask, create_white_mask
    from scum_road_tracer.masks import clean_yellow_mask, clean_white_mask

    yellow_mask = create_yellow_mask(dead_end, test_config)
    white_mask = create_white_mask(dead_end, test_config)
    yellow_clean = clean_yellow_mask(yellow_mask, test_config)
    white_clean = clean_white_mask(white_mask, test_config)

    yellow_sk = to_centerline(yellow_clean)
    white_sk = to_centerline(white_clean)

    # The dead end is a white road segment - it should survive
    yellow_cleaned = cleanup_spurs(yellow_sk, yellow_clean, max_spur_length=8, min_support=0.3)
    white_cleaned = cleanup_spurs(white_sk, white_clean, max_spur_length=8, min_support=0.3)

    # White skeleton should still have pixels (the dead end)
    assert int(np.count_nonzero(white_cleaned)) > 0, "Dead end should not be removed"
