"""Synthetic test image fixtures for SCUM Road Tracer tests.

Generates small synthetic map images programmatically with known road shapes.
No external test files required.
"""

from __future__ import annotations

import numpy as np
import pytest


def make_yellow_color() -> tuple[int, int, int]:
    """Return BGR color for a yellow main road pixel."""
    return (0, 220, 255)  # BGR: Yellow (H~26 in OpenCV)


def make_white_color() -> tuple[int, int, int]:
    """Return BGR color for a white secondary road pixel."""
    return (240, 240, 240)


def make_background_color() -> tuple[int, int, int]:
    """Return BGR color for map background."""
    return (40, 50, 60)


def draw_horizontal_road(
    img: np.ndarray,
    y: int,
    x_start: int,
    x_end: int,
    width: int,
    color: tuple[int, int, int],
) -> None:
    """Draw a horizontal road on the image."""
    h, w = img.shape[:2]
    half = width // 2
    for x in range(x_start, x_end):
        for dy in range(-half, half + 1):
            yy = y + dy
            if 0 <= yy < h and 0 <= x < w:
                img[yy, x] = color


def draw_vertical_road(
    img: np.ndarray,
    x: int,
    y_start: int,
    y_end: int,
    width: int,
    color: tuple[int, int, int],
) -> None:
    """Draw a vertical road on the image."""
    h, w = img.shape[:2]
    half = width // 2
    for y in range(y_start, y_end):
        for dx in range(-half, half + 1):
            xx = x + dx
            if 0 <= y < h and 0 <= xx < w:
                img[y, xx] = color


def draw_diagonal_road(
    img: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    width: int,
    color: tuple[int, int, int],
) -> None:
    """Draw a diagonal road using Bresenham."""
    h, w = img.shape[:2]
    dx = abs(x2 - x1)
    dy = abs(y2 - y1)
    sx = 1 if x1 < x2 else -1
    sy = 1 if y1 < y2 else -1
    err = dx - dy
    half = width // 2
    x, y = x1, y1
    while True:
        for ddx in range(-half, half + 1):
            for ddy in range(-half, half + 1):
                xx, yy = x + ddx, y + ddy
                if 0 <= yy < h and 0 <= xx < w:
                    img[yy, xx] = color
        if x == x2 and y == y2:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy


@pytest.fixture
def small_image():
    """Create a small 200x200 background image."""
    img = np.full((200, 200, 3), make_background_color(), dtype=np.uint8)
    return img


@pytest.fixture
def yellow_horizontal(small_image):
    """Image with a horizontal yellow road."""
    img = small_image.copy()
    draw_horizontal_road(img, 100, 20, 180, 8, make_yellow_color())
    return img


@pytest.fixture
def white_horizontal(small_image):
    """Image with a horizontal white road."""
    img = small_image.copy()
    draw_horizontal_road(img, 100, 20, 180, 5, make_white_color())
    return img


@pytest.fixture
def yellow_white_crossing(small_image):
    """Image with a yellow horizontal and white vertical road crossing."""
    img = small_image.copy()
    draw_horizontal_road(img, 100, 20, 180, 8, make_yellow_color())
    draw_vertical_road(img, 100, 20, 180, 5, make_white_color())
    return img


@pytest.fixture
def curved_road(small_image):
    """Image with a curved white road."""
    img = small_image.copy()
    # Draw a curve using multiple short segments
    for i in range(20, 180, 2):
        y = 100 + int(30 * np.sin((i - 20) * np.pi / 160))
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                yy, xx = y + dy, i + dx
                if 0 <= yy < 200 and 0 <= xx < 200:
                    img[yy, xx] = make_white_color()
    return img


@pytest.fixture
def short_spur(small_image):
    """Image with a main road and a short false spur."""
    img = small_image.copy()
    draw_horizontal_road(img, 100, 20, 180, 8, make_yellow_color())
    # Add a short spur going up from the middle
    draw_vertical_road(img, 100, 95, 105, 3, make_yellow_color())
    return img


@pytest.fixture
def dead_end(small_image):
    """Image with a short dead-end road."""
    img = small_image.copy()
    draw_horizontal_road(img, 100, 20, 120, 8, make_yellow_color())
    # Short dead end going down
    draw_vertical_road(img, 120, 100, 120, 5, make_white_color())
    return img


@pytest.fixture
def gap_image(small_image):
    """Image with two road segments separated by a small gap."""
    img = small_image.copy()
    draw_horizontal_road(img, 100, 20, 98, 8, make_yellow_color())
    draw_horizontal_road(img, 100, 102, 180, 8, make_yellow_color())
    # Gap between x=98 and x=102 (~4 pixels, skeleton endpoints ~12px apart)
    return img


@pytest.fixture
def orange_building(small_image):
    """Image with an orange building outline that should NOT be detected as road."""
    img = small_image.copy()
    # Draw orange rectangle
    cv2_rect = np.array(img)
    for x in range(50, 150):
        img[50, x] = (0, 165, 255)  # Orange top
        img[149, x] = (0, 165, 255)  # Orange bottom
    for y in range(50, 150):
        img[y, 50] = (0, 165, 255)  # Orange left
        img[y, 149] = (0, 165, 255)  # Orange right
    return img


@pytest.fixture
def test_config():
    """Return a test config matching the project config.json structure."""
    return {
        "input": {"default_input_dir": "input", "default_output_dir": "output", "supported_extensions": [".png"]},
        "scaling": {"reference_resolution": 200, "auto_scale": True},
        "colors": {
            "yellow": {
                "hsv_lower": [18, 135, 150], "hsv_upper": [38, 255, 255],
                "lab_lower": [120, 100, 155], "lab_upper": [255, 160, 225],
                "rgb_reference": [255, 212, 0], "rgb_max_delta_e": 60.0,
                "use_lab": False, "use_rgb_delta_e": False,
            },
            "white": {
                "hsv_lower": [0, 0, 185], "hsv_upper": [180, 72, 255],
                "lab_lower": [150, 115, 115], "lab_upper": [255, 155, 155],
                "min_brightness": 185, "max_saturation": 72, "use_lab": False,
            },
            "exclude": {
                "red_hsv_ranges": [[[0, 145, 120], [12, 255, 255]], [[168, 145, 120], [180, 255, 255]]],
                "orange_hsv_lower": [5, 100, 150], "orange_hsv_upper": [20, 255, 255],
                "exclude_orange": True, "exclude_red": True, "building_buffer_size": 0,
            },
        },
        "width_detection": {
            "enabled": True, "min_component_area_for_estimate": 50,
            "fallback_main_width": 14.0, "fallback_secondary_width": 8.0,
            "quantile": 0.5, "accepted_min_factor": 0.6, "accepted_max_factor": 1.5,
        },
        "mask_cleanup": {
            "morph_close_size": 3, "morph_open_size": 3,
            "min_yellow_component_area": 8, "min_white_component_area": 8,
            "remove_large_solid_regions": True,
            "max_solid_region_width": 80, "max_solid_region_height": 80,
            "max_solid_region_fill_ratio": 0.65,
        },
        "gap_bridging": {
            "enabled": True, "max_gap_distance": 15, "tangent_angle_tolerance": 35,
            "pixel_support_radius": 3, "min_confidence": 0.5, "max_bridge_distance_factor": 1.5,
        },
        "graph": {
            "junction_cluster_radius": 5, "min_edge_length": 3,
            "cleanup_spur_max_length": 8, "cleanup_spur_min_support": 0.3,
            "allow_multiple_islands": True, "max_islands": 5, "min_network_area": 150,
        },
        "confidence": {
            "review_threshold": 0.6, "min_color_support": 0.3,
            "min_width_consistency": 0.2, "min_length": 8.0,
            "synthetic_penalty": 0.2, "low_connectivity_penalty": 0.15,
        },
        "polyline": {
            "simplification_epsilon": 2.0, "scale_epsilon": True,
            "preserve_endpoints": True, "preserve_junctions": True,
            "smoothing": False, "smoothing_sigma": 1.0,
        },
        "debug": {"save_debug_masks": True, "save_intermediate_stages": True, "overlay_opacity": 0.7, "log_level": "INFO"},
    }
