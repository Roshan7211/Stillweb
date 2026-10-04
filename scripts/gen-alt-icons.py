#!/usr/bin/env python3
"""Renders Stillweb Plus's alternate app icons: the main icon with other background colors.

    python3 scripts/gen-alt-icons.py

Outputs assets/alt-icons/<Name>.png (1024, opaque RGB like icon.png), which
plugins/with-alternate-icons.js adds to the iOS asset catalog.
"""
import importlib.util
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
spec = importlib.util.spec_from_file_location("gen_icons", os.path.join(ROOT, "scripts", "gen-icons.py"))
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)

# The background gradient's three stops (top-left, middle, bottom-right).
MAIN = ("#4338CA", "#2563EB", "#0891B2")
VARIANTS = {
    "Midnight": ("#0B1020", "#1F2937", "#374151"),
    "Sunset": ("#BE185D", "#EA580C", "#F59E0B"),
    "Forest": ("#064E3B", "#047857", "#10B981"),
    "Violet": ("#4C1D95", "#7C3AED", "#C026D3"),
}


def main():
    svg = open(os.path.join(ROOT, "assets", "source", "stillweb-icon.svg")).read()
    for color in MAIN:
        if color not in svg:
            raise SystemExit(f"stillweb-icon.svg no longer uses {color}; update MAIN")
    out = os.path.join(ROOT, "assets", "alt-icons")
    os.makedirs(out, exist_ok=True)
    for name, colors in VARIANTS.items():
        variant = svg
        for old, new in zip(MAIN, colors):
            variant = variant.replace(old, new)
        w, h, rows = icons.render_svg(variant, 1024)
        icons.encode_png(os.path.join(out, f"{name}.png"), w, h, rows, alpha=False)
        print("wrote", f"assets/alt-icons/{name}.png")


if __name__ == "__main__":
    main()
