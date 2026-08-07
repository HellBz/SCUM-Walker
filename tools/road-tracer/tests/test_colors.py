"""Tests for color detection: yellow and white masks."""

from __future__ import annotations

import numpy as np

from scum_road_tracer.colors import create_yellow_mask, create_white_mask, create_exclusion_mask


def test_yellow_mask_detects_yellow_road(yellow_horizontal, test_config):
    """Yellow road pixels should be detected in the yellow mask."""
    mask = create_yellow_mask(yellow_horizontal, test_config)
    assert mask.sum() > 0, "Yellow mask should have nonzero pixels"
    # The road is at y=100, x=20..180
    assert mask[100, 100] > 0, "Center of yellow road should be detected"


def test_yellow_mask_excludes_background(small_image, test_config):
    """Background pixels should not be in the yellow mask."""
    mask = create_yellow_mask(small_image, test_config)
    assert mask.sum() == 0, "No yellow pixels in background image"


def test_white_mask_detects_white_road(white_horizontal, test_config):
    """White road pixels should be detected in the white mask."""
    mask = create_white_mask(white_horizontal, test_config)
    assert mask.sum() > 0, "White mask should have nonzero pixels"
    assert mask[100, 100] > 0, "Center of white road should be detected"


def test_white_mask_excludes_yellow(yellow_horizontal, test_config):
    """Yellow road pixels should not appear in the white mask."""
    mask = create_white_mask(yellow_horizontal, test_config)
    # The yellow road should not be detected as white
    assert mask[100, 100] == 0, "Yellow road should not be in white mask"


def test_yellow_mask_excludes_orange(orange_building, test_config):
    """Orange building outlines should not be detected as yellow roads."""
    mask = create_yellow_mask(orange_building, test_config)
    # Orange pixels at the building outline should not be in the yellow mask
    assert mask[50, 100] == 0, "Orange building outline should not be in yellow mask"


def test_exclusion_mask_detects_orange(orange_building, test_config):
    """Exclusion mask should detect orange pixels."""
    mask = create_exclusion_mask(orange_building, test_config)
    assert mask[50, 100] > 0, "Orange building outline should be in exclusion mask"
