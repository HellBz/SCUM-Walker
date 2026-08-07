"""Mask cleanup: morphological operations, small component removal, large solid region removal."""

from __future__ import annotations

import logging
from typing import Any

import math

import cv2
import numpy as np

logger = logging.getLogger(__name__)


def odd_size(value: int, minimum: int = 1) -> int:
    """Ensure a value is odd and at least minimum."""
    value = max(minimum, int(value))
    return value if value % 2 == 1 else value + 1


def create_line_kernel(length: int, angle_degrees: float, thickness: int = 1) -> np.ndarray:
    """Create a directional line-shaped structuring element for gap bridging."""
    size = odd_size(length, minimum=3)
    kernel = np.zeros((size, size), dtype=np.uint8)
    center = size // 2
    radius = center
    angle = math.radians(angle_degrees)
    dx = int(round(math.cos(angle) * radius))
    dy = int(round(math.sin(angle) * radius))
    cv2.line(kernel, (center - dx, center - dy), (center + dx, center + dy), 1, max(1, thickness), lineType=cv2.LINE_8)
    return kernel


def connect_directional_gaps(
    mask: np.ndarray,
    gap_length: int,
    line_width: int = 3,
    angle_step: int = 15,
) -> np.ndarray:
    """Bridge small gaps (texture noise, dashed rendering) using multi-angle morphological
    closing, applied before skeletonization. This is more robust against thin-line
    fragmentation than post-skeleton endpoint bridging.
    """
    connected = mask.copy()
    gap_length = odd_size(gap_length, minimum=3)
    line_width = max(1, line_width)
    angle_step = max(5, min(90, angle_step))

    for angle in range(0, 180, angle_step):
        kernel = create_line_kernel(gap_length, float(angle), line_width)
        candidate = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
        connected = cv2.bitwise_or(connected, candidate)

    return connected


def remove_small_components(mask: np.ndarray, minimum_area: int) -> np.ndarray:
    """Remove connected components smaller than minimum_area."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cleaned = np.zeros_like(mask)
    for cid in range(1, count):
        if int(stats[cid, cv2.CC_STAT_AREA]) >= minimum_area:
            cleaned[labels == cid] = 255
    return cleaned


def remove_large_solid_regions(
    mask: np.ndarray,
    max_width: int,
    max_height: int,
    max_fill_ratio: float,
) -> np.ndarray:
    """Remove large solid rectangular regions (buildings, UI overlays)."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cleaned = np.zeros_like(mask)
    for cid in range(1, count):
        w = int(stats[cid, cv2.CC_STAT_WIDTH])
        h = int(stats[cid, cv2.CC_STAT_HEIGHT])
        area = int(stats[cid, cv2.CC_STAT_AREA])
        fill_ratio = area / max(1, w * h)
        is_solid = w >= max_width and h >= max_height and fill_ratio >= max_fill_ratio
        if not is_solid:
            cleaned[labels == cid] = 255
    return cleaned


def clean_mask(mask: np.ndarray, config: dict[str, Any], scale: float = 1.0) -> np.ndarray:
    """Apply directional gap bridging, morphological close/open, and remove small components."""
    cleanup = config["mask_cleanup"]

    working = mask
    if cleanup.get("directional_gap_connect", False):
        gap_length = int(round(float(cleanup.get("gap_connect_length", 9)) * scale))
        line_width = max(1, int(round(float(cleanup.get("gap_connect_width", 3)) * scale)))
        angle_step = int(cleanup.get("gap_connect_angle_step", 15))
        working = connect_directional_gaps(working, gap_length, line_width, angle_step)

    close_size = odd_size(int(cleanup["morph_close_size"] * scale), minimum=1)
    open_size = odd_size(int(cleanup["morph_open_size"] * scale), minimum=1)

    close_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size, close_size))
    open_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_size, open_size))

    cleaned = cv2.morphologyEx(working, cv2.MORPH_CLOSE, close_kernel, iterations=1)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, open_kernel, iterations=1)

    if cleanup.get("remove_large_solid_regions", True):
        cleaned = remove_large_solid_regions(
            cleaned,
            int(cleanup["max_solid_region_width"] * scale),
            int(cleanup["max_solid_region_height"] * scale),
            float(cleanup["max_solid_region_fill_ratio"]),
        )

    return cleaned


def clean_yellow_mask(mask: np.ndarray, config: dict[str, Any], scale: float = 1.0) -> np.ndarray:
    """Clean the yellow mask with type-specific minimum area."""
    min_area = int(config["mask_cleanup"]["min_yellow_component_area"] * scale * scale)
    return remove_small_components(clean_mask(mask, config, scale), max(1, min_area))


def clean_white_mask(mask: np.ndarray, config: dict[str, Any], scale: float = 1.0) -> np.ndarray:
    """Clean the white mask with type-specific minimum area."""
    min_area = int(config["mask_cleanup"]["min_white_component_area"] * scale * scale)
    return remove_small_components(clean_mask(mask, config, scale), max(1, min_area))
