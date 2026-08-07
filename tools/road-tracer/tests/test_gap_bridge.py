"""Tests for gap bridging: endpoint-based connection with validation."""

from __future__ import annotations

import numpy as np

from scum_road_tracer.colors import create_yellow_mask, create_white_mask
from scum_road_tracer.masks import clean_yellow_mask, clean_white_mask
from scum_road_tracer.skeleton import to_centerline
from scum_road_tracer.graph import build_graph
from scum_road_tracer.gap_bridge import bridge_gaps


def test_gap_bridging_connects_aligned_segments(gap_image, test_config):
    """Two aligned road segments with a small gap should be bridged."""
    mask = create_yellow_mask(gap_image, test_config)
    cleaned = clean_yellow_mask(mask, test_config)
    skeleton = to_centerline(cleaned)
    graph = build_graph(skeleton, "main", junction_cluster_radius=5, min_edge_length=3)

    # Before bridging, there should be no synthetic edges
    assert not any(e.synthetic for e in graph.edges)

    # Bridge gaps
    graph = bridge_gaps(graph, cleaned, np.zeros_like(cleaned), test_config, scale=1.0)

    # After bridging, there should be at least one synthetic edge
    synthetic = [e for e in graph.edges if e.synthetic]
    assert len(synthetic) >= 1, "Should have bridged the gap with a synthetic edge"


def test_no_bridging_for_distant_segments(small_image, test_config):
    """Segments that are far apart should NOT be bridged."""
    from tests.conftest import draw_horizontal_road, make_yellow_color
    img = small_image.copy()
    draw_horizontal_road(img, 50, 20, 80, 8, make_yellow_color())
    draw_horizontal_road(img, 150, 20, 80, 8, make_yellow_color())

    mask = create_yellow_mask(img, test_config)
    cleaned = clean_yellow_mask(mask, test_config)
    skeleton = to_centerline(cleaned)
    graph = build_graph(skeleton, "main", junction_cluster_radius=5, min_edge_length=3)

    graph = bridge_gaps(graph, cleaned, np.zeros_like(cleaned), test_config, scale=1.0)

    synthetic = [e for e in graph.edges if e.synthetic]
    assert len(synthetic) == 0, "Distant segments should not be bridged"


def test_bridged_edge_has_confidence(gap_image, test_config):
    """Bridged edges should have a confidence value."""
    mask = create_yellow_mask(gap_image, test_config)
    cleaned = clean_yellow_mask(mask, test_config)
    skeleton = to_centerline(cleaned)
    graph = build_graph(skeleton, "main", junction_cluster_radius=5, min_edge_length=3)
    graph = bridge_gaps(graph, cleaned, np.zeros_like(cleaned), test_config, scale=1.0)

    for edge in graph.edges:
        if edge.synthetic:
            assert 0.0 <= edge.confidence <= 1.0, "Confidence should be in [0, 1]"
