"""Regenerates the NSIS installer art in src-tauri/installer/ from src-tauri/icons/icon.png.

Run: python scripts/generate-installer-art.py (needs Pillow). Output is deterministic.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
OUT = ROOT / "src-tauri" / "installer"

# BMPs have no alpha, so the logo is flattened onto white, matching the NSIS page background.
WHITE = (255, 255, 255)
# Sidebar tint: the icon's dark purple cube face, so the welcome/finish pages share the brand colour.
SIDEBAR_BG = (46, 26, 94)


def flatten(logo: Image.Image, size: int, bg: tuple) -> Image.Image:
    logo = logo.resize((size, size), Image.LANCZOS)
    canvas = Image.new("RGB", logo.size, bg)
    canvas.paste(logo, mask=logo.getchannel("A"))
    return canvas


def main() -> None:
    OUT.mkdir(exist_ok=True)
    logo = Image.open(ICONS / "icon.png").convert("RGBA")

    header = Image.new("RGB", (150, 57), WHITE)
    mark = flatten(logo, 53, WHITE)
    header.paste(mark, (150 - 53 - 4, 2))
    header.save(OUT / "header.bmp", "BMP")

    sidebar = Image.new("RGB", (164, 314), SIDEBAR_BG)
    mark = flatten(logo, 128, SIDEBAR_BG)
    sidebar.paste(mark, (18, 40))
    sidebar.save(OUT / "sidebar.bmp", "BMP")

    # The uninstaller icon reuses the app icon; a separate file keeps the config explicit.
    logo.save(OUT / "uninstaller.ico", "ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])


if __name__ == "__main__":
    main()
