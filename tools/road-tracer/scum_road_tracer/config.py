"""Configuration loading and validation for the SCUM Road Tracer."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_CONFIG_PATH = Path(__file__).parent.parent / "config.json"


def load_config(path: Path | None = None) -> dict[str, Any]:
    """Load and validate the JSON configuration file."""
    if path is None:
        path = DEFAULT_CONFIG_PATH

    if not path.exists():
        raise FileNotFoundError(f"Configuration file not found: {path}")

    with path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)

    _validate_config(config)
    logger.info("Configuration loaded from %s", path)
    return config


def _validate_config(config: dict[str, Any]) -> None:
    """Validate that required top-level sections exist."""
    required_sections = [
        "input", "scaling", "colors", "width_detection",
        "mask_cleanup", "gap_bridging", "graph",
        "confidence", "polyline", "debug",
    ]
    for section in required_sections:
        if section not in config:
            raise ValueError(f"Missing required config section: '{section}'")


def get_scale_factor(config: dict[str, Any], image_width: int) -> float:
    """Compute scale factor based on reference resolution."""
    scaling = config.get("scaling", {})
    if not scaling.get("auto_scale", True):
        return 1.0
    ref = float(scaling.get("reference_resolution", 4096))
    if ref <= 0:
        return 1.0
    return image_width / ref


def scaled_value(value: float, scale: float) -> float:
    """Scale a pixel-based parameter by the given scale factor."""
    return value * scale
