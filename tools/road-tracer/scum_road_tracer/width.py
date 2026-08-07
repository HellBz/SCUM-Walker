"""Road width estimation via distance transform.

Estimates typical yellow and white road widths separately,
using robust quantiles on sufficiently large components.
"""

from __future__ import annotations

import logging
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)


def estimate_road_width(
    mask: np.ndarray,
    min_component_area: int,
    fallback_width: float,
    quantile: float = 0.5,
    accepted_min_factor: float = 0.6,
    accepted_max_factor: float = 1.5,
) -> dict[str, float]:
    """Estimate typical road width from a color mask.

    Uses distance transform on large components, then takes a robust quantile
    of the per-component median widths. Returns a dict with median, accepted_min, accepted_max.
    """
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)

    widths: list[float] = []
    for cid in range(1, count):
        area = int(stats[cid, cv2.CC_STAT_AREA])
        if area < min_component_area:
            continue

        component = (labels == cid).astype(np.uint8) * 255
        dist = cv2.distanceTransform(component, cv2.DIST_L2, 5)
        # Width = 2 * max distance along centerline, use median of nonzero distances
        nonzero = dist[dist > 0]
        if len(nonzero) == 0:
            continue
        comp_width = float(np.quantile(nonzero, quantile)) * 2.0
        widths.append(comp_width)

    if not widths:
        logger.warning("No large components for width estimation, using fallback: %.1f", fallback_width)
        return {
            "median": fallback_width,
            "accepted_min": fallback_width * accepted_min_factor,
            "accepted_max": fallback_width * accepted_max_factor,
        }

    median_width = float(np.median(widths))
    result = {
        "median": round(median_width, 2),
        "accepted_min": round(median_width * accepted_min_factor, 2),
        "accepted_max": round(median_width * accepted_max_factor, 2),
    }
    logger.info("Estimated width: median=%.2f, min=%.2f, max=%.2f",
                result["median"], result["accepted_min"], result["accepted_max"])
    return result


def detect_widths(
    yellow_mask: np.ndarray,
    white_mask: np.ndarray,
    config: dict[str, Any],
    scale: float = 1.0,
) -> dict[str, dict[str, float]]:
    """Detect widths for both yellow and white road masks."""
    wd = config["width_detection"]
    min_area = int(wd["min_component_area_for_estimate"] * scale * scale)

    if not wd.get("enabled", True):
        return {
            "main": {"median": wd["fallback_main_width"], "accepted_min": 0, "accepted_max": 9999},
            "secondary": {"median": wd["fallback_secondary_width"], "accepted_min": 0, "accepted_max": 9999},
        }

    main = estimate_road_width(
        yellow_mask, min_area,
        float(wd["fallback_main_width"]) * scale,
        float(wd["quantile"]),
        float(wd["accepted_min_factor"]),
        float(wd["accepted_max_factor"]),
    )
    secondary = estimate_road_width(
        white_mask, min_area,
        float(wd["fallback_secondary_width"]) * scale,
        float(wd["quantile"]),
        float(wd["accepted_min_factor"]),
        float(wd["accepted_max_factor"]),
    )

    return {"main": main, "secondary": secondary}
