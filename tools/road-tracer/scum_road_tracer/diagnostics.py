"""Diagnostic image generation for debugging the detection pipeline.

Generates per-stage images:
- *_yellow_raw.png, *_yellow_clean.png
- *_white_raw.png, *_white_clean.png
- *_yellow_centerline.png, *_white_centerline.png
- *_accepted.png, *_review.png
- *_overlay.png
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .graph import RoadGraph

logger = logging.getLogger(__name__)


def save_image(path: Path, image: np.ndarray) -> None:
    """Save an image, raising on failure."""
    if not cv2.imwrite(str(path), image):
        raise RuntimeError(f"Could not save image: {path}")


def create_overlay(
    image: np.ndarray,
    graph: RoadGraph,
    opacity: float = 0.7,
) -> np.ndarray:
    """Create a diagnostic overlay showing all road types with color coding.

    Colors:
    - Green: accepted main road
    - White: accepted secondary road
    - Orange: uncertain segment (review_required)
    - Cyan: synthetic connection
    - Red: rejected segment (not used in current pipeline but available)
    """
    overlay = image.copy()

    for edge in graph.edges:
        if len(edge.points) < 2:
            continue

        pts = np.array(edge.points, dtype=np.int32).reshape(-1, 1, 2)

        if edge.synthetic:
            color = (255, 255, 0)  # Cyan in BGR
        elif edge.review_required:
            color = (0, 165, 255)  # Orange in BGR
        elif edge.road_type == "main":
            color = (0, 255, 255)  # Yellow in BGR
        else:
            color = (255, 255, 255)  # White

        cv2.polylines(overlay, [pts], False, color, 2, cv2.LINE_AA)

    # Draw nodes
    for node in graph.nodes:
        if node.node_type == "junction":
            cv2.circle(overlay, (node.x, node.y), 4, (0, 0, 255), -1)
        else:
            cv2.circle(overlay, (node.x, node.y), 3, (255, 0, 0), -1)

    opacity = float(np.clip(opacity, 0.0, 1.0))
    return cv2.addWeighted(image, 1.0 - opacity, overlay, opacity, 0.0)


def create_accepted_image(
    shape: tuple[int, int],
    graph: RoadGraph,
) -> np.ndarray:
    """Create an image showing only accepted (non-review) segments."""
    img = np.zeros((shape[0], shape[1], 3), dtype=np.uint8)

    for edge in graph.edges:
        if edge.review_required or edge.synthetic:
            continue
        if len(edge.points) < 2:
            continue
        pts = np.array(edge.points, dtype=np.int32).reshape(-1, 1, 2)
        color = (0, 255, 255) if edge.road_type == "main" else (255, 255, 255)
        cv2.polylines(img, [pts], False, color, 2, cv2.LINE_AA)

    return img


def create_review_image(
    shape: tuple[int, int],
    graph: RoadGraph,
) -> np.ndarray:
    """Create an image showing only review-required and synthetic segments."""
    img = np.zeros((shape[0], shape[1], 3), dtype=np.uint8)

    for edge in graph.edges:
        if not edge.review_required and not edge.synthetic:
            continue
        if len(edge.points) < 2:
            continue
        pts = np.array(edge.points, dtype=np.int32).reshape(-1, 1, 2)
        if edge.synthetic:
            color = (255, 255, 0)  # Cyan
        else:
            color = (0, 165, 255)  # Orange
        cv2.polylines(img, [pts], False, color, 2, cv2.LINE_AA)

    return img


def save_diagnostics(
    output_dir: Path,
    stem: str,
    image: np.ndarray,
    yellow_raw: np.ndarray,
    yellow_clean: np.ndarray,
    white_raw: np.ndarray,
    white_clean: np.ndarray,
    yellow_centerline: np.ndarray,
    white_centerline: np.ndarray,
    graph: RoadGraph,
    config: dict[str, Any],
) -> None:
    """Save all diagnostic images."""
    debug = config.get("debug", {})
    save_debug = debug.get("save_debug_masks", True)
    opacity = float(debug.get("overlay_opacity", 0.7))

    # Always save overlay
    overlay = create_overlay(image, graph, opacity)
    save_image(output_dir / f"{stem}_overlay.png", overlay)

    # Always save accepted and review
    accepted = create_accepted_image(image.shape[:2], graph)
    save_image(output_dir / f"{stem}_accepted.png", accepted)

    review = create_review_image(image.shape[:2], graph)
    save_image(output_dir / f"{stem}_review.png", review)

    if save_debug:
        save_image(output_dir / f"{stem}_yellow_raw.png", yellow_raw)
        save_image(output_dir / f"{stem}_yellow_clean.png", yellow_clean)
        save_image(output_dir / f"{stem}_white_raw.png", white_raw)
        save_image(output_dir / f"{stem}_white_clean.png", white_clean)
        save_image(output_dir / f"{stem}_yellow_centerline.png", yellow_centerline)
        save_image(output_dir / f"{stem}_white_centerline.png", white_centerline)

    logger.info("Diagnostic images saved to %s", output_dir)
