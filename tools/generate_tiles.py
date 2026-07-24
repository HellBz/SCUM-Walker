"""
Generate Leaflet XYZ tiles from the SCUM map image.
Upscales to 16384x16384 (no padding), then cuts into 256x256 tiles.
Zoom 0-3: src/tiles/        (bundled with app)
Zoom 4-6: tools/tiles-hires/ (for release ZIP)

If the source image is missing, it will be downloaded from Google Drive.
"""
import os
import sys
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SOURCE = os.path.join(os.path.dirname(__file__), "..", "src", "scum_map-14k.png")
TILES_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "tiles")
HIRES_DIR = os.path.join(os.path.dirname(__file__), "tiles-hires")
TILE_SIZE = 256
MAX_ZOOM = 6  # 64x64 tiles at max zoom = 16384x16384px
BUNDLED_MAX_ZOOM = 3  # zoom 0-3 bundled, 4-6 are hi-res
GDRIVE_FILE_ID = "1XqRochYxs4I5M1Lek0R-JWifUXXDwqVv"

def download_source():
    print(f"Source image not found, downloading from Google Drive...")
    try:
        import gdown
    except ImportError:
        print("Installing gdown...")
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "gdown"])
        import gdown
    url = f"https://drive.google.com/uc?id={GDRIVE_FILE_ID}"
    gdown.download(url, SOURCE, quiet=False)

def main():
    if not os.path.exists(SOURCE):
        download_source()
    print(f"Loading {SOURCE} ...")
    img = Image.open(SOURCE)
    print(f"Original size: {img.size}")

    # Upscale to 16384x16384 (no padding, no transparency)
    target = TILE_SIZE * (2 ** MAX_ZOOM)
    img = img.convert("RGB").resize((target, target), Image.LANCZOS)
    print(f"Upscaled to {target}x{target}")

    total_tiles = 0
    for z in range(MAX_ZOOM + 1):
        tiles_per_side = 2 ** z
        map_size = tiles_per_side * TILE_SIZE
        # Downscale the full image to this zoom level
        level_img = img.resize((map_size, map_size), Image.LANCZOS)

        # Zoom 0-3 -> src/tiles, zoom 4-6 -> tools/tiles-hires
        output_dir = TILES_DIR if z <= BUNDLED_MAX_ZOOM else HIRES_DIR
        z_dir = os.path.join(output_dir, str(z))
        os.makedirs(z_dir, exist_ok=True)

        for x in range(tiles_per_side):
            x_dir = os.path.join(z_dir, str(x))
            os.makedirs(x_dir, exist_ok=True)
            for y in range(tiles_per_side):
                tile = level_img.crop((
                    x * TILE_SIZE, y * TILE_SIZE,
                    (x + 1) * TILE_SIZE, (y + 1) * TILE_SIZE
                ))
                tile_path = os.path.join(x_dir, f"{y}.png")
                tile.save(tile_path, "PNG", optimize=True)
                total_tiles += 1

        del level_img
        dest = "src/tiles" if z <= BUNDLED_MAX_ZOOM else "tools/tiles-hires"
        print(f"  Zoom {z}: {tiles_per_side}x{tiles_per_side} tiles -> {dest}")

    print(f"\nTotal tiles generated: {total_tiles}")
    print(f"Bundled (0-3): {TILES_DIR}")
    print(f"Hi-Res  (4-6): {HIRES_DIR}")

if __name__ == "__main__":
    main()
