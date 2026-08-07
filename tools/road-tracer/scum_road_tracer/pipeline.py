"""Main detection pipeline orchestrating all stages.

Stages:
1. Detect yellow main roads
2. Detect white secondary roads
3. Clean color masks
4. Estimate road widths
5. Extract centerlines
6. Clean skeleton spurs
7. Build road graph
8. Bridge gaps
9. Simplify polylines
10. Score confidence
11. Export JSON and diagnostics
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from . import __version__
from .config import get_scale_factor, load_config
from .colors import create_yellow_mask, create_white_mask
from .masks import clean_yellow_mask, clean_white_mask
from .width import detect_widths
from .skeleton import cleanup_spurs, to_centerline
from .graph import RoadGraph, build_graph
from .gap_bridge import bridge_gaps
from .simplify import simplify_edges
from .confidence import score_all_edges
from .export import export_to_v2, save_json
from .diagnostics import save_diagnostics

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def parse_arguments() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="SCUM Road Tracer - Detect road networks from SCUM map images."
    )
    parser.add_argument("--input", type=Path, default=Path("input"), help="Input image or folder.")
    parser.add_argument("--output", type=Path, default=Path("output"), help="Output folder.")
    parser.add_argument("--config", type=Path, default=Path("config.json"), help="JSON config file.")
    parser.add_argument("--log-level", default=None, help="Override log level (DEBUG/INFO/WARNING).")
    return parser.parse_args()


def collect_images(input_path: Path) -> list[Path]:
    """Collect all supported image files from the input path."""
    if input_path.is_file():
        return [input_path]
    if not input_path.exists():
        raise FileNotFoundError(f"Input path not found: {input_path}")
    return sorted(
        p for p in input_path.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS
    )


def process_image(
    image_path: Path,
    output_dir: Path,
    config: dict[str, Any],
) -> None:
    """Process a single image through the full detection pipeline."""
    image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read image: {image_path}")

    height, width = image.shape[:2]
    scale = get_scale_factor(config, width)
    logger.info("Processing %s (%dx%d, scale=%.2f)", image_path.name, width, height, scale)

    # Stage 1-2: Detect yellow and white separately
    yellow_raw = create_yellow_mask(image, config)
    white_raw = create_white_mask(image, config, scale)

    # Stage 3: Clean masks
    yellow_clean = clean_yellow_mask(yellow_raw, config, scale)
    white_clean = clean_white_mask(white_raw, config, scale)

    # Stage 4: Estimate widths
    detected_widths = detect_widths(yellow_clean, white_clean, config, scale)

    # Stage 5: Extract centerlines
    yellow_skeleton = to_centerline(yellow_clean)
    white_skeleton = to_centerline(white_clean)

    # Stage 6: Clean spurs
    graph_cfg = config["graph"]
    spur_max = int(graph_cfg["cleanup_spur_max_length"] * scale)
    spur_min_support = float(graph_cfg["cleanup_spur_min_support"])
    yellow_skeleton = cleanup_spurs(yellow_skeleton, yellow_clean, spur_max, spur_min_support)
    white_skeleton = cleanup_spurs(white_skeleton, white_clean, spur_max, spur_min_support)

    # Stage 7: Build graphs (separate for each type)
    junction_radius = int(graph_cfg["junction_cluster_radius"] * scale)
    min_edge = int(graph_cfg["min_edge_length"] * scale)
    yellow_graph = build_graph(yellow_skeleton, "main", junction_radius, min_edge)
    white_graph = build_graph(white_skeleton, "secondary", junction_radius, min_edge)

    # Merge graphs
    merged = _merge_graphs(yellow_graph, white_graph)

    # Stage 8: Bridge gaps
    merged = bridge_gaps(merged, yellow_clean, white_clean, config, scale)

    # Stage 9: Simplify polylines
    merged.edges = simplify_edges(merged.edges, config, scale)

    # Stage 10: Score confidence
    merged = score_all_edges(merged, yellow_clean, white_clean, detected_widths, config, scale)

    # Stage 11: Export
    output_data = export_to_v2(
        merged,
        source_image=image_path.name,
        image_width=width,
        image_height=height,
        detected_widths=detected_widths,
        settings={"tracer_version": __version__},
    )

    stem = image_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)
    save_json(output_dir / f"{stem}_roads.json", output_data)

    # Save diagnostics
    save_diagnostics(
        output_dir, stem, image,
        yellow_raw, yellow_clean,
        white_raw, white_clean,
        yellow_skeleton, white_skeleton,
        merged, config,
    )

    stats = output_data["statistics"]
    logger.info("Done: %s -> %d roads (%d main, %d secondary, %d review, %d synthetic)",
                image_path.name, stats["road_count"], stats["main_count"],
                stats["secondary_count"], stats["review_required_count"],
                stats["synthetic_count"])


def _merge_graphs(graph1: RoadGraph, graph2: RoadGraph) -> RoadGraph:
    """Merge two road graphs into one, adjusting node IDs."""
    offset = len(graph1.nodes)
    merged = RoadGraph()

    # Copy nodes from graph1
    for n in graph1.nodes:
        merged.nodes.append(n)

    # Copy nodes from graph2 with offset
    for n in graph2.nodes:
        n.id += offset
        merged.nodes.append(n)

    # Copy edges from graph1
    for e in graph1.edges:
        merged.edges.append(e)

    # Copy edges from graph2 with offset node references
    for e in graph2.edges:
        e.from_node += offset
        e.to_node += offset
        merged.edges.append(e)

    return merged


def main() -> None:
    """Main entry point for the SCUM Road Tracer."""
    args = parse_arguments()

    log_level = args.log_level or "INFO"
    logging.basicConfig(
        level=getattr(logging, log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    config = load_config(args.config)
    args.output.mkdir(parents=True, exist_ok=True)

    images = collect_images(args.input)
    if not images:
        raise RuntimeError(f"No supported images found in: {args.input}")

    for image_path in images:
        process_image(image_path, args.output, config)

    logger.info("All done. Output folder: %s", args.output.resolve())


if __name__ == "__main__":
    main()
