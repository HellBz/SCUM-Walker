"""Skeleton extraction and spur cleanup.

Extracts centerlines from road masks using scikit-image skeletonize,
then cleans up short false spurs that have low color support.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import cv2
import numpy as np
from skimage.morphology import skeletonize

logger = logging.getLogger(__name__)

Pixel = tuple[int, int]


def to_centerline(mask: np.ndarray) -> np.ndarray:
    """Extract a 1-pixel-wide centerline from a binary mask."""
    binary = mask > 0
    centerline = skeletonize(binary)
    return centerline.astype(np.uint8) * 255


def get_neighbors(pixel: Pixel, skeleton_pixels: set[Pixel]) -> list[Pixel]:
    """Get 8-connected neighbors that are in the skeleton."""
    y, x = pixel
    neighbors: list[Pixel] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            candidate = (y + dy, x + dx)
            if candidate in skeleton_pixels:
                neighbors.append(candidate)
    return neighbors


def classify_skeleton_pixels(skeleton_pixels: set[Pixel]) -> tuple[set[Pixel], set[Pixel]]:
    """Classify skeleton pixels into endpoints (1 neighbor) and junctions (3+ neighbors)."""
    neighbor_map = {p: get_neighbors(p, skeleton_pixels) for p in skeleton_pixels}
    endpoints = {p for p, n in neighbor_map.items() if len(n) == 1}
    junctions = {p for p, n in neighbor_map.items() if len(n) >= 3}
    return endpoints, junctions


def cleanup_spurs(
    skeleton: np.ndarray,
    color_mask: np.ndarray,
    max_spur_length: int,
    min_support: float,
    support_radius: int = 3,
) -> np.ndarray:
    """Remove short false spurs that end at a junction and have low color support.

    A spur is removed only if:
    - It is short (<= max_spur_length pixels)
    - It ends at a junction
    - It has low support in the original color mask (< min_support fraction)
    """
    cleaned = skeleton.copy()
    skeleton_pixels = {(int(y), int(x)) for y, x in np.argwhere(skeleton > 0)}
    if not skeleton_pixels:
        return cleaned

    _, junctions = classify_skeleton_pixels(skeleton_pixels)
    neighbor_map = {p: get_neighbors(p, skeleton_pixels) for p in skeleton_pixels}

    visited: set[Pixel] = set()
    for junction in junctions:
        for start_neighbor in neighbor_map.get(junction, []):
            if start_neighbor in visited or start_neighbor in junctions:
                continue

            # Trace the spur from the junction neighbor
            path: list[Pixel] = [junction, start_neighbor]
            prev = junction
            curr = start_neighbor
            while True:
                neighbors = [n for n in neighbor_map.get(curr, []) if n != prev]
                if len(neighbors) != 1:
                    break
                nxt = neighbors[0]
                path.append(nxt)
                prev = curr
                curr = nxt
                if curr in junctions or curr in visited:
                    break

            spur_pixels = path[1:]  # exclude the junction itself
            if len(spur_pixels) > max_spur_length:
                for p in spur_pixels:
                    visited.add(p)
                continue

            # Check color support
            support = _compute_support(spur_pixels, color_mask, support_radius)
            if support < min_support:
                for p in spur_pixels:
                    y, x = p
                    cleaned[y, x] = 0
                    logger.debug("Removed spur pixel (%d, %d) support=%.2f", y, x, support)
            else:
                for p in spur_pixels:
                    visited.add(p)

    return cleaned


def _compute_support(
    pixels: list[Pixel],
    color_mask: np.ndarray,
    radius: int,
) -> float:
    """Compute the fraction of pixels that have color mask support within a radius."""
    if not pixels:
        return 0.0
    h, w = color_mask.shape[:2]
    hits = 0
    for y, x in pixels:
        y1, y2 = max(0, y - radius), min(h, y + radius + 1)
        x1, x2 = max(0, x - radius), min(w, x + radius + 1)
        if np.any(color_mask[y1:y2, x1:x2] > 0):
            hits += 1
    return hits / len(pixels)
