"""Color detection for yellow main roads and white secondary roads.

Uses HSV, LAB, and optional RGB delta-E to create separate masks.
Never combines yellow and white before detection and validation.
"""

from __future__ import annotations

import logging
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)


def create_yellow_mask(image: np.ndarray, config: dict[str, Any]) -> np.ndarray:
    """Detect yellow main road pixels using HSV + optional LAB + RGB delta-E."""
    colors = config["colors"]
    yellow_cfg = colors["yellow"]

    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hsv_lower = np.array(yellow_cfg["hsv_lower"], dtype=np.uint8)
    hsv_upper = np.array(yellow_cfg["hsv_upper"], dtype=np.uint8)
    mask = cv2.inRange(hsv, hsv_lower, hsv_upper)

    if yellow_cfg.get("use_lab", False):
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        lab_lower = np.array(yellow_cfg["lab_lower"], dtype=np.uint8)
        lab_upper = np.array(yellow_cfg["lab_upper"], dtype=np.uint8)
        lab_mask = cv2.inRange(lab, lab_lower, lab_upper)
        mask = cv2.bitwise_and(mask, lab_mask)

    if yellow_cfg.get("use_rgb_delta_e", False):
        ref = np.array(yellow_cfg["rgb_reference"], dtype=np.float32)
        max_delta = float(yellow_cfg["rgb_max_delta_e"])
        diff = image.astype(np.float32) - ref
        delta = np.sqrt(np.sum(diff * diff, axis=2))
        rgb_mask = (delta <= max_delta).astype(np.uint8) * 255
        mask = cv2.bitwise_and(mask, rgb_mask)

    # Exclude orange building outlines
    exclude_cfg = colors.get("exclude", {})
    if exclude_cfg.get("exclude_orange", True):
        orange_lower = np.array(exclude_cfg["orange_hsv_lower"], dtype=np.uint8)
        orange_upper = np.array(exclude_cfg["orange_hsv_upper"], dtype=np.uint8)
        orange_mask = cv2.inRange(hsv, orange_lower, orange_upper)
        mask = cv2.bitwise_and(mask, cv2.bitwise_not(orange_mask))

    # Exclude red rail lines
    if exclude_cfg.get("exclude_red", True):
        red_mask = _create_red_mask(hsv, exclude_cfg)
        mask = cv2.bitwise_and(mask, cv2.bitwise_not(red_mask))

    logger.info("Yellow mask: %d pixels", int(np.count_nonzero(mask)))
    return mask


def create_white_mask(image: np.ndarray, config: dict[str, Any], scale: float = 1.0) -> np.ndarray:
    """Detect white secondary road pixels using HSV + optional LAB.

    White detection is intentionally conservative: high brightness, low saturation,
    and optionally LAB constraints. Does not include orange, red, or yellow pixels.
    Pixels near buildings (orange) are excluded via a dilation buffer, since
    pavement and courtyards inside settlements are often light-colored but are
    not roads.
    """
    colors = config["colors"]
    white_cfg = colors["white"]

    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hsv_lower = np.array(white_cfg["hsv_lower"], dtype=np.uint8)
    hsv_upper = np.array(white_cfg["hsv_upper"], dtype=np.uint8)
    mask = cv2.inRange(hsv, hsv_lower, hsv_upper)

    if white_cfg.get("use_lab", False):
        lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
        lab_lower = np.array(white_cfg["lab_lower"], dtype=np.uint8)
        lab_upper = np.array(white_cfg["lab_upper"], dtype=np.uint8)
        lab_mask = cv2.inRange(lab, lab_lower, lab_upper)
        mask = cv2.bitwise_and(mask, lab_mask)

    # Exclude yellow pixels from white mask
    yellow_hsv_lower = np.array(colors["yellow"]["hsv_lower"], dtype=np.uint8)
    yellow_hsv_upper = np.array(colors["yellow"]["hsv_upper"], dtype=np.uint8)
    yellow_mask = cv2.inRange(hsv, yellow_hsv_lower, yellow_hsv_upper)
    mask = cv2.bitwise_and(mask, cv2.bitwise_not(yellow_mask))

    # Exclude orange, including a buffer zone around buildings to remove
    # pavement/courtyards inside settlements that are not roads
    exclude_cfg = colors.get("exclude", {})
    if exclude_cfg.get("exclude_orange", True):
        orange_lower = np.array(exclude_cfg["orange_hsv_lower"], dtype=np.uint8)
        orange_upper = np.array(exclude_cfg["orange_hsv_upper"], dtype=np.uint8)
        orange_mask = cv2.inRange(hsv, orange_lower, orange_upper)

        buffer_size = int(exclude_cfg.get("building_buffer_size", 0) * scale)
        if buffer_size > 0:
            kernel = cv2.getStructuringElement(
                cv2.MORPH_ELLIPSE, (buffer_size * 2 + 1, buffer_size * 2 + 1)
            )
            orange_mask = cv2.dilate(orange_mask, kernel)

        mask = cv2.bitwise_and(mask, cv2.bitwise_not(orange_mask))

    # Exclude red
    if exclude_cfg.get("exclude_red", True):
        red_mask = _create_red_mask(hsv, exclude_cfg)
        mask = cv2.bitwise_and(mask, cv2.bitwise_not(red_mask))

    logger.info("White mask: %d pixels", int(np.count_nonzero(mask)))
    return mask


def _create_red_mask(hsv: np.ndarray, exclude_cfg: dict[str, Any]) -> np.ndarray:
    """Create a red exclusion mask from HSV ranges."""
    red_mask = np.zeros(hsv.shape[:2], dtype=np.uint8)
    for lower_vals, upper_vals in exclude_cfg.get("red_hsv_ranges", []):
        lower = np.array(lower_vals, dtype=np.uint8)
        upper = np.array(upper_vals, dtype=np.uint8)
        red_mask = cv2.bitwise_or(red_mask, cv2.inRange(hsv, lower, upper))
    return red_mask


def create_exclusion_mask(image: np.ndarray, config: dict[str, Any]) -> np.ndarray:
    """Create a combined exclusion mask (red + orange) for diagnostic purposes."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    exclude_cfg = config["colors"].get("exclude", {})
    combined = np.zeros(image.shape[:2], dtype=np.uint8)

    if exclude_cfg.get("exclude_red", True):
        combined = cv2.bitwise_or(combined, _create_red_mask(hsv, exclude_cfg))
    if exclude_cfg.get("exclude_orange", True):
        orange_lower = np.array(exclude_cfg["orange_hsv_lower"], dtype=np.uint8)
        orange_upper = np.array(exclude_cfg["orange_hsv_upper"], dtype=np.uint8)
        combined = cv2.bitwise_or(combined, cv2.inRange(hsv, orange_lower, orange_upper))

    return combined
