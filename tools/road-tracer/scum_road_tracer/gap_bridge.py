"""Endpoint-based gap bridging with pixel support validation.

Connects nearby road endpoints only when:
- Distance is within a scaled maximum
- Tangent directions are compatible
- The bridge path has sufficient color support
- No inappropriate regions are crossed
"""

from __future__ import annotations

import logging
import math
from typing import Any

import cv2
import numpy as np

from .graph import GraphEdge, GraphNode, RoadGraph

logger = logging.getLogger(__name__)


def bridge_gaps(
    graph: RoadGraph,
    yellow_mask: np.ndarray,
    white_mask: np.ndarray,
    config: dict[str, Any],
    scale: float = 1.0,
) -> RoadGraph:
    """Bridge gaps between nearby endpoints with tangent and pixel support checks."""
    gb = config["gap_bridging"]
    if not gb.get("enabled", True):
        return graph

    max_dist = float(gb["max_gap_distance"]) * scale
    angle_tol = float(gb["tangent_angle_tolerance"])
    support_radius = int(gb["pixel_support_radius"] * scale)
    min_confidence = float(gb["min_confidence"])
    max_bridge_dist = float(gb.get("max_bridge_distance_factor", 1.5)) * scale

    combined_mask = cv2.bitwise_or(yellow_mask, white_mask)
    exclusion_mask = _build_exclusion_mask(yellow_mask, white_mask)

    # Collect all endpoints from both graphs
    endpoints = [n for n in graph.nodes if n.node_type == "endpoint"]
    next_edge_id = max((e.id for e in graph.edges), default=0) + 1

    used: set[int] = set()
    for i, ep1 in enumerate(endpoints):
        if ep1.id in used:
            continue
        for j, ep2 in enumerate(endpoints):
            if i >= j or ep2.id in used:
                continue

            dist = math.hypot(ep1.x - ep2.x, ep1.y - ep2.y)
            if dist > max_dist or dist < 1:
                continue

            # Check tangent compatibility
            if not _check_tangent(graph, ep1, ep2, angle_tol):
                continue

            # Check pixel support along the bridge line
            confidence = _check_bridge_support(
                ep1, ep2, combined_mask, exclusion_mask, support_radius
            )

            if confidence < min_confidence:
                logger.debug("Bridge rejected: low confidence %.2f for %s->%s",
                             confidence, ep1.id, ep2.id)
                continue

            # Create synthetic edge
            points = _interpolate_line(ep1.x, ep1.y, ep2.x, ep2.y)
            next_edge_id += 1
            edge = GraphEdge(
                id=next_edge_id,
                from_node=ep1.id,
                to_node=ep2.id,
                road_type=_determine_bridge_type(ep1, ep2, graph),
                points=points,
                confidence=round(confidence, 2),
                synthetic=True,
                length_pixels=round(dist, 2),
            )
            edge.review_required = confidence < 0.7
            graph.edges.append(edge)
            used.add(ep1.id)
            used.add(ep2.id)
            logger.info("Bridged gap: %s->%s dist=%.1f conf=%.2f",
                        ep1.id, ep2.id, dist, confidence)
            break

    return graph


def _check_tangent(graph: RoadGraph, ep1: GraphNode, ep2: GraphNode, angle_tol: float) -> bool:
    """Check if the tangent directions at two endpoints are compatible."""
    # Find the edge connected to each endpoint to determine tangent
    edge1 = None
    edge2 = None
    for e in graph.edges:
        if e.from_node == ep1.id or e.to_node == ep1.id:
            edge1 = e
            break
    for e in graph.edges:
        if e.from_node == ep2.id or e.to_node == ep2.id:
            edge2 = e
            break

    if edge1 is None or edge2 is None:
        return True  # Can't check, allow

    # Get tangent at ep1 (direction FROM the endpoint INTO the edge, then reverse to get outward direction)
    pts1 = edge1.points
    if edge1.from_node == ep1.id:
        # Endpoint is at start of points, tangent points into edge -> reverse for outward
        t1 = _angle(pts1[1], pts1[0])
    else:
        # Endpoint is at end of points, tangent points into edge -> reverse for outward
        t1 = _angle(pts1[-2], pts1[-1])

    # Get tangent at ep2 (outward direction)
    pts2 = edge2.points
    if edge2.from_node == ep2.id:
        t2 = _angle(pts2[1], pts2[0])
    else:
        t2 = _angle(pts2[-2], pts2[-1])

    # The bridge direction from ep1 to ep2
    bridge_angle_1to2 = _angle([ep1.x, ep1.y], [ep2.x, ep2.y])
    # The bridge direction from ep2 to ep1 (reverse)
    bridge_angle_2to1 = _angle([ep2.x, ep2.y], [ep1.x, ep1.y])

    # Check that each endpoint's outward tangent aligns with the bridge direction away from it
    diff1 = abs(_angle_diff(t1, bridge_angle_1to2))
    diff2 = abs(_angle_diff(t2, bridge_angle_2to1))

    return diff1 <= angle_tol and diff2 <= angle_tol


def _angle(p1: list[int], p2: list[int]) -> float:
    """Compute angle in degrees between two points."""
    return math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0]))


def _angle_diff(a1: float, a2: float) -> float:
    """Compute the smallest angular difference between two angles."""
    diff = (a1 - a2 + 180) % 360 - 180
    return diff


def _check_bridge_support(
    ep1: GraphNode,
    ep2: GraphNode,
    combined_mask: np.ndarray,
    exclusion_mask: np.ndarray,
    radius: int,
) -> float:
    """Check pixel support along the bridge line. Returns confidence [0, 1]."""
    h, w = combined_mask.shape[:2]
    points = _interpolate_line(ep1.x, ep1.y, ep2.x, ep2.y)

    support_hits = 0
    exclusion_hits = 0
    total = len(points)

    for px, py in points:
        if not (0 <= px < w and 0 <= py < h):
            total -= 1
            continue
        y1, y2 = max(0, py - radius), min(h, py + radius + 1)
        x1, x2 = max(0, px - radius), min(w, px + radius + 1)
        if np.any(combined_mask[y1:y2, x1:x2] > 0):
            support_hits += 1
        if np.any(exclusion_mask[y1:y2, x1:x2] > 0):
            exclusion_hits += 1

    if total == 0:
        return 0.0

    support_ratio = support_hits / total
    exclusion_ratio = exclusion_hits / total

    confidence = support_ratio * (1.0 - exclusion_ratio * 0.5)
    return max(0.0, min(1.0, confidence))


def _interpolate_line(x1: int, y1: int, x2: int, y2: int) -> list[list[int]]:
    """Bresenham line interpolation between two points."""
    points: list[list[int]] = []
    dx = abs(x2 - x1)
    dy = abs(y2 - y1)
    sx = 1 if x1 < x2 else -1
    sy = 1 if y1 < y2 else -1
    err = dx - dy
    x, y = x1, y1
    while True:
        points.append([x, y])
        if x == x2 and y == y2:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy
    return points


def _build_exclusion_mask(yellow_mask: np.ndarray, white_mask: np.ndarray) -> np.ndarray:
    """Build an exclusion mask: areas that are neither yellow nor white but have content.

    For now, this is a placeholder that returns zeros. In a full implementation,
    this would identify orange/red regions to avoid bridging through.
    """
    return np.zeros_like(yellow_mask)


def _determine_bridge_type(ep1: GraphNode, ep2: GraphNode, graph: RoadGraph) -> str:
    """Determine the road type for a bridge edge based on connected edges."""
    type1 = None
    type2 = None
    for e in graph.edges:
        if (e.from_node == ep1.id or e.to_node == ep1.id) and type1 is None:
            type1 = e.road_type
        if (e.from_node == ep2.id or e.to_node == ep2.id) and type2 is None:
            type2 = e.road_type
        if type1 and type2:
            break

    if type1 == "main" and type2 == "main":
        return "main"
    return "secondary"
