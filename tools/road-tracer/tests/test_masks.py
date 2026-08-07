"""Tests for mask cleanup."""

from __future__ import annotations

import numpy as np

from scum_road_tracer.masks import remove_small_components, clean_yellow_mask, clean_white_mask


def test_remove_small_components_removes_noise():
    """Small isolated components should be removed."""
    mask = np.zeros((100, 100), dtype=np.uint8)
    # Large component
    mask[10:50, 10:50] = 255
    # Small noise
    mask[0, 0] = 255
    mask[1, 1] = 255
    cleaned = remove_small_components(mask, minimum_area=10)
    assert cleaned[0, 0] == 0, "Small noise should be removed"
    assert cleaned[30, 30] == 255, "Large component should remain"


def test_clean_yellow_mask_preserves_road(yellow_horizontal, test_config):
    """Yellow road should survive cleanup."""
    from scum_road_tracer.colors import create_yellow_mask
    raw = create_yellow_mask(yellow_horizontal, test_config)
    cleaned = clean_yellow_mask(raw, test_config, scale=1.0)
    assert cleaned.sum() > 0, "Yellow road should survive cleanup"


def test_clean_white_mask_preserves_road(white_horizontal, test_config):
    """White road should survive cleanup."""
    from scum_road_tracer.colors import create_white_mask
    raw = create_white_mask(white_horizontal, test_config)
    cleaned = clean_white_mask(raw, test_config, scale=1.0)
    assert cleaned.sum() > 0, "White road should survive cleanup"
