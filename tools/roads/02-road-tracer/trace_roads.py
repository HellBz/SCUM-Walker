from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from skimage.morphology import skeletonize


Point = tuple[int, int]


def create_white_road_mask(image: np.ndarray) -> np.ndarray:
    """
    Detect near-white roads while rejecting most colored terrain.
    """
    b, g, r = cv2.split(image)

    minimum_channel = cv2.min(cv2.min(b, g), r)
    maximum_channel = cv2.max(cv2.max(b, g), r)
    channel_difference = cv2.subtract(maximum_channel, minimum_channel)

    brightness_mask = cv2.inRange(
        minimum_channel,
        190,
        255,
    )

    neutral_color_mask = cv2.inRange(
        channel_difference,
        0,
        45,
    )

    mask = cv2.bitwise_and(
        brightness_mask,
        neutral_color_mask,
    )

    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (3, 3),
    )

    return cv2.morphologyEx(
        mask,
        cv2.MORPH_OPEN,
        kernel,
        iterations=1,
    )


def filter_by_local_width(
    mask: np.ndarray,
    minimum_radius: float = 0.8,
    maximum_radius: float = 9.0,
) -> np.ndarray:
    """
    Keep line-like regions with a local width similar to roads.
    """
    binary = (mask > 0).astype(np.uint8)

    distance = cv2.distanceTransform(
        binary,
        cv2.DIST_L2,
        5,
    )

    valid_width = (
        (distance >= minimum_radius)
        & (distance <= maximum_radius)
    )

    center_mask = np.zeros_like(mask)
    center_mask[valid_width] = 255

    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (5, 5),
    )

    center_mask = cv2.dilate(
        center_mask,
        kernel,
        iterations=1,
    )

    return cv2.bitwise_and(
        center_mask,
        mask,
    )


def create_red_mask(image: np.ndarray) -> np.ndarray:
    """
    Detect red road and railway pixels.
    """
    hsv = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2HSV,
    )

    lower_red_1 = np.array(
        [0, 120, 130],
        dtype=np.uint8,
    )
    upper_red_1 = np.array(
        [12, 255, 255],
        dtype=np.uint8,
    )

    lower_red_2 = np.array(
        [168, 120, 130],
        dtype=np.uint8,
    )
    upper_red_2 = np.array(
        [179, 255, 255],
        dtype=np.uint8,
    )

    mask_1 = cv2.inRange(
        hsv,
        lower_red_1,
        upper_red_1,
    )
    mask_2 = cv2.inRange(
        hsv,
        lower_red_2,
        upper_red_2,
    )

    return cv2.bitwise_or(
        mask_1,
        mask_2,
    )


def remove_small_red_components(
    red_mask: np.ndarray,
    minimum_area: int,
    minimum_extent: int,
) -> np.ndarray:
    """
    Remove short isolated red components, which are usually railway dashes.
    """
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(
        red_mask,
        connectivity=8,
    )

    result = np.zeros_like(red_mask)

    for label in range(1, component_count):
        width = stats[label, cv2.CC_STAT_WIDTH]
        height = stats[label, cv2.CC_STAT_HEIGHT]
        area = stats[label, cv2.CC_STAT_AREA]

        extent = max(width, height)

        if area < minimum_area:
            continue

        if extent < minimum_extent:
            continue

        result[labels == label] = 255

    return result


def clean_mask(
    mask: np.ndarray,
    gap_size: int,
) -> np.ndarray:
    """
    Close small gaps while limiting accidental links between nearby roads.
    """
    gap_size = max(1, int(gap_size))

    if gap_size % 2 == 0:
        gap_size += 1

    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (gap_size, gap_size),
    )

    return cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        kernel,
        iterations=1,
    )


def bridge_skeleton_endpoints(
    skeleton: np.ndarray,
    maximum_gap: float,
) -> np.ndarray:
    """
    Connect nearby skeleton endpoints to close small extraction gaps.
    """
    result = skeleton.copy()

    ys, xs = np.where(result > 0)
    pixels = set(zip(xs.tolist(), ys.tolist()))

    endpoints = [
        point
        for point in pixels
        if len(get_neighbors(point, pixels)) == 1
    ]

    used: set[Point] = set()

    for index, first in enumerate(endpoints):
        if first in used:
            continue

        best: Point | None = None
        best_distance = float("inf")

        for second in endpoints[index + 1:]:
            if second in used:
                continue

            dx = second[0] - first[0]
            dy = second[1] - first[1]
            distance = float(np.hypot(dx, dy))

            if distance <= maximum_gap and distance < best_distance:
                best = second
                best_distance = distance

        if best is None:
            continue

        cv2.line(
            result,
            first,
            best,
            color=1,
            thickness=1,
            lineType=cv2.LINE_8,
        )

        used.add(first)
        used.add(best)

    return result


def mask_to_skeleton(mask: np.ndarray) -> np.ndarray:
    binary = mask > 0
    skeleton = skeletonize(binary)

    return skeleton.astype(np.uint8)


def get_neighbors(
    point: Point,
    pixels: set[Point],
) -> list[Point]:
    x, y = point
    neighbors: list[Point] = []

    for offset_y in (-1, 0, 1):
        for offset_x in (-1, 0, 1):
            if offset_x == 0 and offset_y == 0:
                continue

            candidate = (
                x + offset_x,
                y + offset_y,
            )

            if candidate in pixels:
                neighbors.append(candidate)

    return neighbors


def prune_short_branches(
    skeleton: np.ndarray,
    minimum_branch_length: int,
    iterations: int = 5,
) -> np.ndarray:
    """
    Remove short dead-end branches from the skeleton.
    """
    result = skeleton.copy()

    for _ in range(iterations):
        ys, xs = np.where(result > 0)
        pixels = set(
            zip(
                xs.tolist(),
                ys.tolist(),
            )
        )

        neighbor_map = {
            point: get_neighbors(
                point,
                pixels,
            )
            for point in pixels
        }

        endpoints = [
            point
            for point, neighbors in neighbor_map.items()
            if len(neighbors) == 1
        ]

        remove_pixels: set[Point] = set()

        for endpoint in endpoints:
            path = [endpoint]
            previous: Point | None = None
            current = endpoint

            while len(path) <= minimum_branch_length:
                candidates = [
                    neighbor
                    for neighbor in neighbor_map.get(
                        current,
                        [],
                    )
                    if neighbor != previous
                ]

                if len(candidates) != 1:
                    break

                next_point = candidates[0]

                previous = current
                current = next_point
                path.append(current)

                degree = len(
                    neighbor_map.get(
                        current,
                        [],
                    )
                )

                if degree >= 3:
                    if len(path) <= minimum_branch_length:
                        remove_pixels.update(path[:-1])
                    break

                if degree == 1:
                    break

        if not remove_pixels:
            break

        for x, y in remove_pixels:
            result[y, x] = 0

    return result


def build_skeleton_graph(
    skeleton: np.ndarray,
) -> tuple[set[Point], dict[Point, list[Point]]]:
    ys, xs = np.where(skeleton > 0)

    pixels = set(
        zip(
            xs.tolist(),
            ys.tolist(),
        )
    )

    graph = {
        point: get_neighbors(
            point,
            pixels,
        )
        for point in pixels
    }

    return pixels, graph


def trace_polylines(
    skeleton: np.ndarray,
) -> list[list[Point]]:
    pixels, graph = build_skeleton_graph(skeleton)

    if not pixels:
        return []

    nodes = {
        point
        for point, neighbors in graph.items()
        if len(neighbors) != 2
    }

    visited_edges: set[frozenset[Point]] = set()
    polylines: list[list[Point]] = []

    def edge_key(
        first: Point,
        second: Point,
    ) -> frozenset[Point]:
        return frozenset(
            (
                first,
                second,
            )
        )

    for start in nodes:
        for neighbor in graph[start]:
            first_edge = edge_key(
                start,
                neighbor,
            )

            if first_edge in visited_edges:
                continue

            line = [start]
            previous = start
            current = neighbor

            visited_edges.add(first_edge)
            line.append(current)

            while current not in nodes:
                candidates = [
                    point
                    for point in graph[current]
                    if point != previous
                ]

                if not candidates:
                    break

                next_point = candidates[0]
                current_edge = edge_key(
                    current,
                    next_point,
                )

                if current_edge in visited_edges:
                    break

                visited_edges.add(current_edge)

                previous = current
                current = next_point
                line.append(current)

            if len(line) >= 2:
                polylines.append(line)

    for point in pixels:
        for neighbor in graph[point]:
            first_edge = edge_key(
                point,
                neighbor,
            )

            if first_edge in visited_edges:
                continue

            line = [point]
            start = point
            previous = point
            current = neighbor

            visited_edges.add(first_edge)
            line.append(current)

            while True:
                candidates = [
                    candidate
                    for candidate in graph[current]
                    if candidate != previous
                ]

                if not candidates:
                    break

                next_point = candidates[0]
                current_edge = edge_key(
                    current,
                    next_point,
                )

                if current_edge in visited_edges:
                    break

                visited_edges.add(current_edge)

                previous = current
                current = next_point
                line.append(current)

                if current == start:
                    break

            if len(line) >= 3:
                polylines.append(line)

    return polylines


def simplify_polyline(
    points: list[Point],
    epsilon: float,
) -> list[Point]:
    if len(points) < 3:
        return points

    contour = np.array(
        points,
        dtype=np.float32,
    ).reshape(
        (-1, 1, 2)
    )

    simplified = cv2.approxPolyDP(
        contour,
        epsilon,
        False,
    )

    return [
        (
            int(point[0][0]),
            int(point[0][1]),
        )
        for point in simplified
    ]


def polyline_length(
    points: list[Point],
) -> float:
    length = 0.0

    for first, second in zip(
        points,
        points[1:],
    ):
        dx = second[0] - first[0]
        dy = second[1] - first[1]

        length += float(
            np.hypot(
                dx,
                dy,
            )
        )

    return length


def remove_short_polylines(
    polylines: list[list[Point]],
    minimum_length: float,
) -> list[list[Point]]:
    return [
        line
        for line in polylines
        if polyline_length(line) >= minimum_length
    ]


def classify_road(
    line: list[Point],
    red_mask: np.ndarray,
    white_mask: np.ndarray,
) -> tuple[str, float, float]:
    """
    Classify a road by rasterizing the complete polyline over expanded masks.
    """
    height, width = red_mask.shape[:2]

    line_mask = np.zeros(
        (height, width),
        dtype=np.uint8,
    )

    points = np.array(
        line,
        dtype=np.int32,
    ).reshape((-1, 1, 2))

    cv2.polylines(
        line_mask,
        [points],
        isClosed=False,
        color=255,
        thickness=3,
        lineType=cv2.LINE_8,
    )

    sample_count = int(np.count_nonzero(line_mask))

    if sample_count == 0:
        return "secondary", 0.0, 0.0

    sample_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (7, 7),
    )

    red_sample_mask = cv2.dilate(
        red_mask,
        sample_kernel,
        iterations=1,
    )

    white_sample_mask = cv2.dilate(
        white_mask,
        sample_kernel,
        iterations=1,
    )

    red_hits = int(
        np.count_nonzero(
            cv2.bitwise_and(
                line_mask,
                red_sample_mask,
            )
        )
    )

    white_hits = int(
        np.count_nonzero(
            cv2.bitwise_and(
                line_mask,
                white_sample_mask,
            )
        )
    )

    red_ratio = red_hits / sample_count
    white_ratio = white_hits / sample_count

    road_type = (
        "primary"
        if red_ratio >= 0.20 and red_ratio >= white_ratio
        else "secondary"
    )

    return (
        road_type,
        red_ratio,
        white_ratio,
    )


def create_preview(
    image: np.ndarray,
    polylines: list[list[Point]],
) -> np.ndarray:
    preview = image.copy()

    for line in polylines:
        points = np.array(
            line,
            dtype=np.int32,
        ).reshape(
            (-1, 1, 2)
        )

        cv2.polylines(
            preview,
            [points],
            isClosed=False,
            color=(255, 0, 255),
            thickness=2,
            lineType=cv2.LINE_AA,
        )

    return preview


def scale_polyline(
    line: list[Point],
    scale_x: float,
    scale_y: float,
) -> list[Point]:
    return [
        (
            int(round(x * scale_x)),
            int(round(y * scale_y)),
        )
        for x, y in line
    ]


def save_json(
    output_path: Path,
    source_image: Path,
    image: np.ndarray,
    polylines: list[list[Point]],
    red_mask: np.ndarray,
    white_mask: np.ndarray,
    target_width: int,
    target_height: int,
) -> None:
    source_height, source_width = image.shape[:2]

    scale_x = target_width / source_width
    scale_y = target_height / source_height

    roads = []

    for index, source_line in enumerate(
        polylines,
        start=1,
    ):
        road_type, red_ratio, white_ratio = classify_road(
            source_line,
            red_mask,
            white_mask,
        )

        scaled_line = scale_polyline(
            source_line,
            scale_x,
            scale_y,
        )

        roads.append(
            {
                "id": index,
                "network_id": 1,
                "network": "mainland",
                "type": road_type,
                "length_pixels": round(
                    polyline_length(scaled_line),
                    2,
                ),
                "yellow_ratio": round(
                    red_ratio,
                    4,
                ),
                "red_ratio": round(
                    red_ratio,
                    4,
                ),
                "white_ratio": round(
                    white_ratio,
                    4,
                ),
                "points": [
                    [x, y]
                    for x, y in scaled_line
                ],
            }
        )

    data = {
        "source_image": source_image.name,
        "image": {
            "width": target_width,
            "height": target_height,
        },
        "world_bounds": {
            "min_x": -904800,
            "max_x": 619318,
            "min_y": -904800,
            "max_y": 618818,
        },
        "source_image_size": {
            "width": source_width,
            "height": source_height,
        },
        "coordinate_system": {
            "origin": "top-left",
            "point_order": [
                "x",
                "y",
            ],
            "x_direction": "right",
            "y_direction": "down",
        },
        "statistics": {
            "network_count": 1,
            "road_count": len(roads),
            "rail_count": 0,
        },
        "networks": [
            {
                "id": 1,
                "name": "mainland",
                "area": target_width * target_height,
                "yellow_overlap": int(
                    np.count_nonzero(red_mask)
                    * scale_x
                    * scale_y
                ),
                "red_overlap": int(
                    np.count_nonzero(red_mask)
                    * scale_x
                    * scale_y
                ),
                "white_overlap": int(
                    np.count_nonzero(white_mask)
                    * scale_x
                    * scale_y
                ),
                "bounding_box": {
                    "x": 0,
                    "y": 0,
                    "width": target_width,
                    "height": target_height,
                },
                "road_count": len(roads),
                "roads": roads,
            }
        ],
    }

    output_path.write_text(
        json.dumps(
            data,
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract road centerlines from a SCUM tactical map.",
    )

    parser.add_argument(
        "input",
        type=Path,
    )

    parser.add_argument(
        "--output",
        type=Path,
        default=Path("roads.json"),
    )

    parser.add_argument(
        "--preview",
        type=Path,
        default=Path("roads_preview.png"),
    )

    parser.add_argument(
        "--mask-preview",
        type=Path,
        default=Path("roads_mask.png"),
    )

    parser.add_argument(
        "--white-min-radius",
        type=float,
        default=0.8,
    )

    parser.add_argument(
        "--white-max-radius",
        type=float,
        default=9.0,
    )

    parser.add_argument(
        "--red-min-area",
        type=int,
        default=350,
    )

    parser.add_argument(
        "--red-min-extent",
        type=int,
        default=80,
    )

    parser.add_argument(
        "--branch-length",
        type=int,
        default=35,
    )

    parser.add_argument(
        "--minimum-road-length",
        type=float,
        default=40.0,
    )

    parser.add_argument(
        "--simplify",
        type=float,
        default=2.5,
    )

    parser.add_argument(
        "--gap-size",
        type=int,
        default=7,
    )

    parser.add_argument(
        "--endpoint-gap",
        type=float,
        default=18.0,
    )

    parser.add_argument(
        "--target-width",
        type=int,
        default=14481,
    )

    parser.add_argument(
        "--target-height",
        type=int,
        default=14481,
    )

    args = parser.parse_args()

    image = cv2.imread(
        str(args.input),
        cv2.IMREAD_COLOR,
    )

    if image is None:
        raise RuntimeError(
            f"Could not open image: {args.input}"
        )

    white_mask_raw = create_white_road_mask(
        image
    )

    white_mask = filter_by_local_width(
        white_mask_raw,
        minimum_radius=args.white_min_radius,
        maximum_radius=args.white_max_radius,
    )

    red_mask_raw = create_red_mask(
        image
    )

    red_mask = remove_small_red_components(
        red_mask_raw,
        minimum_area=args.red_min_area,
        minimum_extent=args.red_min_extent,
    )

    road_mask = cv2.bitwise_or(
        white_mask,
        red_mask,
    )

    road_mask = clean_mask(
        road_mask,
        gap_size=args.gap_size,
    )

    skeleton = mask_to_skeleton(
        road_mask
    )

    skeleton = bridge_skeleton_endpoints(
        skeleton,
        maximum_gap=args.endpoint_gap,
    )

    skeleton = prune_short_branches(
        skeleton,
        minimum_branch_length=args.branch_length,
    )

    polylines = trace_polylines(
        skeleton
    )

    polylines = remove_short_polylines(
        polylines,
        minimum_length=args.minimum_road_length,
    )

    polylines = [
        simplify_polyline(
            line,
            args.simplify,
        )
        for line in polylines
    ]

    save_json(
        args.output,
        args.input,
        image,
        polylines,
        red_mask,
        white_mask,
        target_width=args.target_width,
        target_height=args.target_height,
    )

    preview = create_preview(
        image,
        polylines,
    )

    cv2.imwrite(
        str(args.preview),
        preview,
    )

    cv2.imwrite(
        str(args.mask_preview),
        road_mask,
    )

    cv2.imwrite(
        "white_mask_raw.png",
        white_mask_raw,
    )

    cv2.imwrite(
        "white_mask_filtered.png",
        white_mask,
    )

    cv2.imwrite(
        "red_mask_raw.png",
        red_mask_raw,
    )

    cv2.imwrite(
        "red_mask_filtered.png",
        red_mask,
    )

    print()
    print(f"Roads found: {len(polylines)}")
    print(f"JSON saved: {args.output}")
    print(f"Preview saved: {args.preview}")
    print(f"Mask saved: {args.mask_preview}")


if __name__ == "__main__":
    main()
