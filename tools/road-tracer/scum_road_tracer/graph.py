"""Graph building from skeleton: nodes, edges, junction clustering.

Converts a skeleton image into a graph with:
- Nodes: endpoints, junctions (clustered), type transitions
- Edges: ordered pixel paths between nodes
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .skeleton import Pixel, get_neighbors

logger = logging.getLogger(__name__)


@dataclass
class GraphNode:
    """A node in the road graph."""
    id: int
    x: int
    y: int
    node_type: str  # "endpoint", "junction", "transition"
    pixel: Pixel = field(default=(0, 0))


@dataclass
class GraphEdge:
    """An edge in the road graph representing a road segment."""
    id: int
    from_node: int
    to_node: int
    road_type: str  # "main" or "secondary"
    points: list[list[int]] = field(default_factory=list)
    confidence: float = 1.0
    review_required: bool = False
    synthetic: bool = False
    length_pixels: float = 0.0


@dataclass
class RoadGraph:
    """The complete road graph."""
    nodes: list[GraphNode] = field(default_factory=list)
    edges: list[GraphEdge] = field(default_factory=list)


def _edge_key(a: Pixel, b: Pixel) -> tuple[Pixel, Pixel]:
    return (a, b) if a <= b else (b, a)


def cluster_junctions(junctions: set[Pixel], radius: int) -> dict[Pixel, Pixel]:
    """Cluster nearby junction pixels into single logical junctions.

    Returns a mapping from each junction pixel to its cluster representative.
    """
    if not junctions:
        return {}

    sorted_junctions = sorted(junctions)
    assigned: dict[Pixel, Pixel] = {}
    clusters: list[list[Pixel]] = []

    for j in sorted_junctions:
        if j in assigned:
            continue
        cluster = [j]
        assigned[j] = j
        for other in sorted_junctions:
            if other in assigned:
                continue
            dy, dx = other[0] - j[0], other[1] - j[1]
            if dy * dy + dx * dx <= radius * radius:
                cluster.append(other)
                assigned[other] = j
        clusters.append(cluster)

    # Compute centroid of each cluster and map all members to centroid
    result: dict[Pixel, Pixel] = {}
    for cluster in clusters:
        cy = sum(p[0] for p in cluster) // len(cluster)
        cx = sum(p[1] for p in cluster) // len(cluster)
        centroid = (cy, cx)
        for p in cluster:
            result[p] = centroid

    return result


def trace_skeleton_paths(skeleton: np.ndarray) -> list[list[Pixel]]:
    """Trace all paths in the skeleton between nodes (endpoints and junctions)."""
    skeleton_pixels = {(int(y), int(x)) for y, x in np.argwhere(skeleton > 0)}
    if not skeleton_pixels:
        return []

    neighbor_map = {p: get_neighbors(p, skeleton_pixels) for p in skeleton_pixels}
    node_pixels = {p for p, n in neighbor_map.items() if len(n) != 2}

    visited_edges: set[tuple[Pixel, Pixel]] = set()
    paths: list[list[Pixel]] = []

    # Trace from each node
    for node in node_pixels:
        for neighbor in neighbor_map[node]:
            key = _edge_key(node, neighbor)
            if key in visited_edges:
                continue

            path = [node]
            prev = node
            curr = neighbor
            visited_edges.add(key)

            while True:
                path.append(curr)
                if curr in node_pixels and curr != node:
                    break
                candidates = [
                    c for c in neighbor_map[curr]
                    if c != prev and _edge_key(curr, c) not in visited_edges
                ]
                if not candidates:
                    break
                nxt = candidates[0]
                visited_edges.add(_edge_key(curr, nxt))
                prev = curr
                curr = nxt

            if len(path) >= 2:
                paths.append(path)

    # Trace remaining cycles
    for start in skeleton_pixels:
        unvisited = [n for n in neighbor_map[start] if _edge_key(start, n) not in visited_edges]
        for neighbor in unvisited:
            path = [start]
            prev = start
            curr = neighbor
            visited_edges.add(_edge_key(start, neighbor))

            while True:
                path.append(curr)
                candidates = [
                    c for c in neighbor_map[curr]
                    if c != prev and _edge_key(curr, c) not in visited_edges
                ]
                if not candidates:
                    break
                nxt = candidates[0]
                visited_edges.add(_edge_key(curr, nxt))
                prev = curr
                curr = nxt
                if curr == start:
                    path.append(curr)
                    break

            if len(path) >= 3:
                paths.append(path)

    return paths


def build_graph(
    skeleton: np.ndarray,
    road_type: str,
    junction_cluster_radius: int = 5,
    min_edge_length: int = 3,
) -> RoadGraph:
    """Build a RoadGraph from a skeleton image for a given road type."""
    skeleton_pixels = {(int(y), int(x)) for y, x in np.argwhere(skeleton > 0)}
    if not skeleton_pixels:
        return RoadGraph()

    neighbor_map = {p: get_neighbors(p, skeleton_pixels) for p in skeleton_pixels}
    endpoints = {p for p, n in neighbor_map.items() if len(n) == 1}
    junctions = {p for p, n in neighbor_map.items() if len(n) >= 3}

    # Cluster junctions
    junction_map = cluster_junctions(junctions, junction_cluster_radius)

    # Build node set: endpoints + junction centroids
    node_pixels: set[Pixel] = set()
    for ep in endpoints:
        node_pixels.add(ep)
    for centroid in set(junction_map.values()):
        node_pixels.add(centroid)

    # Assign node IDs
    node_list = sorted(node_pixels)
    node_id_map: dict[Pixel, int] = {}
    nodes: list[GraphNode] = []
    for i, p in enumerate(node_list):
        y, x = p
        ntype = "junction" if p in set(junction_map.values()) else "endpoint"
        node_id_map[p] = i
        nodes.append(GraphNode(id=i, x=x, y=y, node_type=ntype, pixel=p))

    # Trace paths and create edges
    paths = trace_skeleton_paths(skeleton)
    edges: list[GraphEdge] = []
    edge_id = 0

    for path in paths:
        if len(path) < 2:
            continue

        # Map path endpoints to node IDs (via junction clustering)
        start_pixel = path[0]
        end_pixel = path[-1]

        # Resolve to clustered junction if applicable
        start_node_pixel = junction_map.get(start_pixel, start_pixel)
        end_node_pixel = junction_map.get(end_pixel, end_pixel)

        if start_node_pixel not in node_id_map or end_node_pixel not in node_id_map:
            continue

        # Convert path pixels (y, x) to points [x, y]
        points = [[int(p[1]), int(p[0])] for p in path]

        # Compute length
        length = 0.0
        for i in range(1, len(points)):
            dx = points[i][0] - points[i - 1][0]
            dy = points[i][1] - points[i - 1][1]
            length += math.hypot(dx, dy)

        if length < min_edge_length:
            continue

        edge_id += 1
        edges.append(GraphEdge(
            id=edge_id,
            from_node=node_id_map[start_node_pixel],
            to_node=node_id_map[end_node_pixel],
            road_type=road_type,
            points=points,
            length_pixels=round(length, 2),
        ))

    logger.info("Built graph: %d nodes, %d edges (%s)", len(nodes), len(edges), road_type)
    return RoadGraph(nodes=nodes, edges=edges)
