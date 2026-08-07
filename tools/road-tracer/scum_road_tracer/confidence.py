"""Confidence scoring for road segments.

Computes a transparent confidence score based on:
- Color support along the segment
- Width consistency
- Segment length
- Connectivity to the road network
- Synthetic pixel fraction
- Shape continuity
"""

from __future__ import annotations

import logging
import math
from typing import Any

import cv2
import numpy as np

from .graph import GraphEdge, RoadGraph

logger = logging.getLogger(__name__)


def compute_confidence(
    edge: GraphEdge,
    color_mask: np.ndarray,
    detected_width: dict[str, float],
    graph: RoadGraph,
    config: dict[str, Any],
    scale: float = 1.0,
) -> tuple[float, bool]:
    """Compute confidence score for an edge. Returns (confidence, review_required)."""
    conf_cfg = config["confidence"]
    review_threshold = float(conf_cfg["review_threshold"])

    # 1. Color support
    color_support = _compute_color_support(edge.points, color_mask, int(3 * scale))

    # 2. Width consistency (simplified: check if distance transform values are consistent)
    width_score = _compute_width_score(edge.points, color_mask, detected_width, int(3 * scale))

    # 3. Length score
    length = edge.length_pixels
    min_length = float(conf_cfg["min_length"]) * scale
    length_score = min(1.0, length / max(1.0, min_length * 3))

    # 4. Connectivity
    connectivity_score = _compute_connectivity(edge, graph)

    # 5. Synthetic penalty
    synthetic_penalty = conf_cfg.get("synthetic_penalty", 0.2) if edge.synthetic else 0.0

    # 6. Low connectivity penalty
    low_conn_penalty = conf_cfg.get("low_connectivity_penalty", 0.15)
    if connectivity_score < 0.5:
        conn_penalty = low_conn_penalty
    else:
        conn_penalty = 0.0

    # Weighted combination
    confidence = (
        color_support * 0.35
        + width_score * 0.20
        + length_score * 0.15
        + connectivity_score * 0.20
        + 0.10  # base confidence
    )

    confidence -= synthetic_penalty
    confidence -= conn_penalty
    confidence = max(0.0, min(1.0, confidence))

    review_required = confidence < review_threshold
    return round(confidence, 2), review_required


def _compute_color_support(
    points: list[list[int]],
    color_mask: np.ndarray,
    radius: int,
) -> float:
    """Fraction of points that have color mask support within radius."""
    if not points:
        return 0.0
    h, w = color_mask.shape[:2]
    hits = 0
    for x, y in points:
        y1, y2 = max(0, y - radius), min(h, y + radius + 1)
        x1, x2 = max(0, x - radius), min(w, x + radius + 1)
        if np.any(color_mask[y1:y2, x1:x2] > 0):
            hits += 1
    return hits / len(points)


def _compute_width_score(
    points: list[list[int]],
    color_mask: np.ndarray,
    detected_width: dict[str, float],
    radius: int,
) -> float:
    """Check if the road width along the segment is consistent with detected width."""
    if not points or not detected_width:
        return 0.5

    expected = detected_width.get("median", 10.0)
    accepted_min = detected_width.get("accepted_min", expected * 0.6)
    accepted_max = detected_width.get("accepted_max", expected * 1.5)

    h, w = color_mask.shape[:2]
    widths: list[float] = []
    for x, y in points:
        y1, y2 = max(0, y - radius), min(h, y + radius + 1)
        x1, x2 = max(0, x - radius), min(w, x + radius + 1)
        patch = color_mask[y1:y2, x1:x2]
        if np.any(patch > 0):
            dist = cv2.distanceTransform(patch, cv2.DIST_L2, 5)
            nonzero = dist[dist > 0]
            if len(nonzero) > 0:
                widths.append(float(np.median(nonzero)) * 2.0)

    if not widths:
        return 0.3

    in_range = sum(1 for wv in widths if accepted_min <= wv <= accepted_max)
    return in_range / len(widths)


def _compute_connectivity(edge: GraphEdge, graph: RoadGraph) -> float:
    """Check how well-connected an edge is to the rest of the graph."""
    from_count = sum(1 for e in graph.edges if e.from_node == edge.from_node or e.to_node == edge.from_node)
    to_count = sum(1 for e in graph.edges if e.from_node == edge.to_node or e.to_node == edge.to_node)

    # 1 connection at each end = dead end (0.5), 2+ at each = well connected (1.0)
    score = 0.0
    if from_count >= 2:
        score += 0.5
    elif from_count >= 1:
        score += 0.25
    if to_count >= 2:
        score += 0.5
    elif to_count >= 1:
        score += 0.25

    return min(1.0, score)


def score_all_edges(
    graph: RoadGraph,
    yellow_mask: np.ndarray,
    white_mask: np.ndarray,
    detected_widths: dict[str, dict[str, float]],
    config: dict[str, Any],
    scale: float = 1.0,
) -> RoadGraph:
    """Compute confidence for all edges in the graph."""
    for edge in graph.edges:
        mask = yellow_mask if edge.road_type == "main" else white_mask
        widths = detected_widths.get(edge.road_type, detected_widths.get("secondary", {}))
        confidence, review = compute_confidence(edge, mask, widths, graph, config, scale)
        edge.confidence = confidence
        edge.review_required = review

    reviewed = sum(1 for e in graph.edges if e.review_required)
    logger.info("Confidence scored: %d edges, %d need review", len(graph.edges), reviewed)
    return graph
