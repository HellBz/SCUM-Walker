"""Polyline simplification using Douglas-Peucker.

Preserves endpoints and junctions. Tolerance scales with image resolution.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)


def simplify_path(
    points: list[list[int]],
    epsilon: float,
    preserve_endpoints: bool = True,
) -> list[list[int]]:
    """Simplify a polyline using Douglas-Peucker (via cv2.approxPolyDP)."""
    if len(points) < 2:
        return points

    contour = np.array(
        [[[p[0], p[1]]] for p in points],
        dtype=np.float32,
    )

    simplified = cv2.approxPolyDP(contour, epsilon=max(0.0, epsilon), closed=False)
    result = [[int(round(pt[0][0])), int(round(pt[0][1]))] for pt in simplified]

    if preserve_endpoints and len(result) >= 2:
        # Ensure exact endpoint preservation
        result[0] = points[0]
        result[-1] = points[-1]

    return result


def calculate_path_length(points: list[list[int]]) -> float:
    """Calculate the total Euclidean length of a polyline."""
    total = 0.0
    for i in range(1, len(points)):
        dx = points[i][0] - points[i - 1][0]
        dy = points[i][1] - points[i - 1][1]
        total += math.hypot(dx, dy)
    return total


def simplify_edges(
    edges: list[Any],
    config: dict[str, Any],
    scale: float = 1.0,
) -> list[Any]:
    """Simplify all edges in place. Returns the modified list."""
    poly_cfg = config["polyline"]
    epsilon = float(poly_cfg["simplification_epsilon"])
    if poly_cfg.get("scale_epsilon", True):
        epsilon *= scale
    preserve = poly_cfg.get("preserve_endpoints", True)

    for edge in edges:
        edge.points = simplify_path(edge.points, epsilon, preserve)
        edge.length_pixels = round(calculate_path_length(edge.points), 2)

    return edges
