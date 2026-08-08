from __future__ import annotations

from io import BytesIO
from pathlib import Path
from time import sleep

import requests
from PIL import Image


BASE_URL = (
    "https://cdn.scum-map.com/tiles/scum/island/"
    "v50.0.2025.06.17-scum-1.0/tactical/{z}/{x}_{y}.webp"
)

ZOOM = 6

# A tile that is known to exist
KNOWN_X = 4
KNOWN_Y = 3

OUTPUT_DIR = Path(f"tiles_z{ZOOM}")
OUTPUT_FILE = Path(f"scum_map_z{ZOOM}.png")

REQUEST_DELAY = 0.05
TIMEOUT = 20

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0"
})


def build_url(z: int, x: int, y: int) -> str:
    return BASE_URL.format(z=z, x=x, y=y)


def tile_exists(z: int, x: int, y: int) -> bool:
    if x < 0 or y < 0:
        return False

    url = build_url(z, x, y)

    try:
        response = session.head(
            url,
            timeout=TIMEOUT,
            allow_redirects=True
        )

        if response.status_code == 405:
            response = session.get(
                url,
                timeout=TIMEOUT,
                stream=True
            )

        exists = response.status_code == 200
        response.close()

        print(
            f"Probe z={z}, x={x}, y={y}: "
            f"{'exists' if exists else 'missing'}"
        )

        sleep(REQUEST_DELAY)
        return exists

    except requests.RequestException as exc:
        print(f"Probe failed for {url}: {exc}")
        return False


def find_axis_max(
    z: int,
    fixed_coordinate: int,
    start: int,
    axis: str
) -> int:
    if axis not in {"x", "y"}:
        raise ValueError("axis must be 'x' or 'y'")

    def exists(value: int) -> bool:
        if axis == "x":
            return tile_exists(z, value, fixed_coordinate)

        return tile_exists(z, fixed_coordinate, value)

    if not exists(start):
        raise RuntimeError(
            f"The known start tile is invalid for axis {axis}: {start}"
        )

    valid = start
    step = 1
    invalid = start + step

    # Exponentially expand until the first missing tile is found
    while exists(invalid):
        valid = invalid
        step *= 2
        invalid = start + step

    # Find the exact last valid coordinate
    low = valid
    high = invalid

    while low + 1 < high:
        middle = (low + high) // 2

        if exists(middle):
            low = middle
        else:
            high = middle

    return low


def find_axis_min(
    z: int,
    fixed_coordinate: int,
    start: int,
    axis: str
) -> int:
    if axis not in {"x", "y"}:
        raise ValueError("axis must be 'x' or 'y'")

    def exists(value: int) -> bool:
        if axis == "x":
            return tile_exists(z, value, fixed_coordinate)

        return tile_exists(z, fixed_coordinate, value)

    valid = start
    step = 1
    invalid = start - step

    # Exponentially expand backwards until a missing tile is found
    while invalid >= 0 and exists(invalid):
        valid = invalid
        step *= 2
        invalid = start - step

    invalid = max(-1, invalid)

    low = invalid
    high = valid

    while low + 1 < high:
        middle = (low + high) // 2

        if exists(middle):
            high = middle
        else:
            low = middle

    return high


def download_tile(z: int, x: int, y: int) -> Image.Image | None:
    url = build_url(z, x, y)
    target = OUTPUT_DIR / f"{x}_{y}.webp"

    if target.exists():
        try:
            return Image.open(target).convert("RGB")
        except Exception:
            target.unlink(missing_ok=True)

    try:
        response = session.get(url, timeout=TIMEOUT)

        if response.status_code == 404:
            print(f"Missing inside detected bounds: {x}_{y}")
            return None

        response.raise_for_status()

        image = Image.open(BytesIO(response.content)).convert("RGB")
        target.write_bytes(response.content)

        print(f"Downloaded: {x}_{y}")
        sleep(REQUEST_DELAY)

        return image

    except requests.RequestException as exc:
        print(f"Download failed for {url}: {exc}")
        return None
    except Exception as exc:
        print(f"Invalid image for {url}: {exc}")
        return None


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if not tile_exists(ZOOM, KNOWN_X, KNOWN_Y):
        raise RuntimeError(
            f"Known tile does not exist: "
            f"z={ZOOM}, x={KNOWN_X}, y={KNOWN_Y}"
        )

    min_x = find_axis_min(
        ZOOM,
        fixed_coordinate=KNOWN_Y,
        start=KNOWN_X,
        axis="x"
    )

    max_x = find_axis_max(
        ZOOM,
        fixed_coordinate=KNOWN_Y,
        start=KNOWN_X,
        axis="x"
    )

    min_y = find_axis_min(
        ZOOM,
        fixed_coordinate=KNOWN_X,
        start=KNOWN_Y,
        axis="y"
    )

    max_y = find_axis_max(
        ZOOM,
        fixed_coordinate=KNOWN_X,
        start=KNOWN_Y,
        axis="y"
    )

    print()
    print("Detected tile bounds:")
    print(f"X: {min_x} to {max_x}")
    print(f"Y: {min_y} to {max_y}")

    tiles: dict[tuple[int, int], Image.Image] = {}
    tile_width: int | None = None
    tile_height: int | None = None

    for y in range(min_y, max_y + 1):
        for x in range(min_x, max_x + 1):
            image = download_tile(ZOOM, x, y)

            if image is None:
                continue

            if tile_width is None or tile_height is None:
                tile_width, tile_height = image.size

            tiles[(x, y)] = image

    if not tiles or tile_width is None or tile_height is None:
        raise RuntimeError("No tiles were downloaded.")

    output_width = (max_x - min_x + 1) * tile_width
    output_height = (max_y - min_y + 1) * tile_height

    stitched = Image.new(
        "RGB",
        (output_width, output_height)
    )

    for (x, y), image in tiles.items():
        offset_x = (x - min_x) * tile_width
        offset_y = (y - min_y) * tile_height

        stitched.paste(image, (offset_x, offset_y))

    stitched.save(OUTPUT_FILE)

    # Copy + resize a dedicated version for the road tracer
    tracer_dir = Path(__file__).resolve().parent.parent / "02-road-tracer"
    tracer_dir.mkdir(parents=True, exist_ok=True)
    tracer_file = tracer_dir / "scum_map_14481.png"
    resized = stitched.resize((14481, 14481), Image.LANCZOS)
    resized.save(tracer_file)

    print()
    print(f"Saved: {OUTPUT_FILE}")
    print(f"Resolution: {output_width} x {output_height}")
    print(f"Downloaded tiles: {len(tiles)}")
    print(f"Tracer copy: {tracer_file} (14481 x 14481)")


if __name__ == "__main__":
    main()