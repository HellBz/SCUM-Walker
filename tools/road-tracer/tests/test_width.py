"""Tests for road width estimation."""

from __future__ import annotations

import numpy as np

from scum_road_tracer.width import estimate_road_width, detect_widths
from scum_road_tracer.colors import create_yellow_mask, create_white_mask


def test_width_estimation_yellow_road(yellow_horizontal, test_config):
    """Width estimation should detect a width close to 8 pixels for the yellow road."""
    mask = create_yellow_mask(yellow_horizontal, test_config)
    result = estimate_road_width(mask, min_component_area=50, fallback_width=14.0)
    assert result["median"] > 0, "Median width should be positive"
    assert result["accepted_min"] > 0
    assert result["accepted_max"] > result["accepted_min"]


def test_width_estimation_white_road(white_horizontal, test_config):
    """Width estimation should detect a width close to 5 pixels for the white road."""
    mask = create_white_mask(white_horizontal, test_config)
    result = estimate_road_width(mask, min_component_area=50, fallback_width=8.0)
    assert result["median"] > 0, "Median width should be positive"


def test_width_estimation_fallback_on_empty(small_image, test_config):
    """Width estimation should use fallback when no large components exist."""
    mask = np.zeros((100, 100), dtype=np.uint8)
    result = estimate_road_width(mask, min_component_area=50, fallback_width=14.0)
    assert result["median"] == 14.0, "Should use fallback width"


def test_detect_widths_returns_both(test_config):
    """detect_widths should return both main and secondary widths."""
    from tests.conftest import draw_horizontal_road, make_yellow_color, make_white_color, make_background_color
    img = np.full((200, 200, 3), make_background_color(), dtype=np.uint8)
    draw_horizontal_road(img, 50, 20, 180, 8, make_yellow_color())
    draw_horizontal_road(img, 150, 20, 180, 5, make_white_color())
    yellow = create_yellow_mask(img, test_config)
    white = create_white_mask(img, test_config)
    result = detect_widths(yellow, white, test_config, scale=1.0)
    assert "main" in result
    assert "secondary" in result
    assert result["main"]["median"] > 0
    assert result["secondary"]["median"] > 0


def test_width_curved_road(curved_road, test_config):
    """Width estimation should work on curved roads."""
    mask = create_white_mask(curved_road, test_config)
    result = estimate_road_width(mask, min_component_area=50, fallback_width=8.0)
    assert result["median"] > 0, "Curved road width should be detected"
