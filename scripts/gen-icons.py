#!/usr/bin/env python3
"""Renders the Stillweb icons from assets/source/*.svg (macOS: uses Quick Look to rasterise).

    python3 scripts/gen-icons.py

Outputs (assets/):
  icon.png                     1024, opaque RGB (the App Store rejects icons with alpha)
  android-icon-background.png  adaptive icon background (gradient)
  android-icon-foreground.png  adaptive icon foreground (white glyph inside the safe zone)
  android-icon-monochrome.png  themed-icon layer (same glyph)
  splash-icon.png              white glyph for the launch screen
  favicon.png                  48px
"""
import os
import re
import shutil
import struct
import subprocess
import tempfile
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "assets", "source")
OUT = os.path.join(ROOT, "assets")

# Android adaptive icons show the middle 72dp of 108dp and may mask to a 66dp circle;
# scaling the glyph keeps its corners inside that circle.
ADAPTIVE_SCALE = 0.72


def render_svg(svg_text, size):
    """Rasterises SVG with Quick Look; returns (width, height, rows of RGBA bytes)."""
    tmp = tempfile.mkdtemp()
    try:
        path = os.path.join(tmp, "in.svg")
        with open(path, "w") as f:
            f.write(svg_text)
        subprocess.run(["qlmanage", "-t", "-s", str(size), "-o", tmp, path], check=True, capture_output=True)
        return decode_png(os.path.join(tmp, "in.svg.png"))
    finally:
        shutil.rmtree(tmp)


def decode_png(path):
    data = open(path, "rb").read()
    pos, idat = 8, b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", chunk[:10])
            if depth != 8 or color not in (2, 6) or chunk[12] != 0:
                raise ValueError("expected 8-bit non-interlaced RGB/RGBA")
        elif kind == b"IDAT":
            idat += chunk
        pos += 12 + length
    bpp = 4 if color == 6 else 3
    raw = zlib.decompress(idat)
    stride = width * bpp
    rows, prev = [], bytearray(stride)
    i = 0
    for _ in range(height):
        ftype = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if ftype == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 0xFF
        elif ftype == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ftype == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif ftype == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 0xFF
        prev = line
        if bpp == 3:
            line = bytearray(b"".join(bytes(line[x:x + 3]) + b"\xff" for x in range(0, stride, 3)))
        rows.append(bytes(line))
    return width, height, rows


def encode_png(path, width, height, rows, alpha):
    if not alpha:
        rows = [bytes(b for j, b in enumerate(r) if j % 4 != 3) for r in rows]
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6 if alpha else 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def mask_to_white(rows):
    """White-on-black render -> white glyph whose alpha is the luminance."""
    out = []
    for r in rows:
        line = bytearray()
        for x in range(0, len(r), 4):
            line += bytes((255, 255, 255, r[x + 1]))  # green channel ~ luminance for a grey image
        out.append(bytes(line))
    return out


def scaled(svg_text, scale):
    """Wraps the drawing in a transform that scales it about the centre."""
    offset = 512 * (1 - scale)
    body = re.sub(r"^.*?<svg[^>]*>", "", svg_text, flags=re.S).rsplit("</svg>", 1)[0]
    defs = re.search(r"<defs>.*?</defs>", body, flags=re.S)
    defs_text = defs.group(0) if defs else ""
    body = body.replace(defs_text, "")
    # Keep the black backdrop full-size so the mask stays transparent outside the glyph.
    body = body.replace('<rect width="1024" height="1024" fill="#000"/>', "")
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        + defs_text
        + '<rect width="1024" height="1024" fill="#000"/>'
        + f'<g transform="translate({offset} {offset}) scale({scale})">{body}</g></svg>'
    )


def main():
    icon_svg = open(os.path.join(SRC, "stillweb-icon.svg")).read()
    glyph_svg = open(os.path.join(SRC, "stillweb-glyph.svg")).read()
    # Background layer: the icon without the shield group.
    background_svg = re.sub(r"<g filter=.*?</g>", "", icon_svg, flags=re.S)

    w, h, rows = render_svg(icon_svg, 1024)
    encode_png(os.path.join(OUT, "icon.png"), w, h, rows, alpha=False)
    print("wrote icon.png")

    w, h, rows = render_svg(background_svg, 1024)
    encode_png(os.path.join(OUT, "android-icon-background.png"), w, h, rows, alpha=False)
    print("wrote android-icon-background.png")

    w, h, rows = render_svg(scaled(glyph_svg, ADAPTIVE_SCALE), 1024)
    white = mask_to_white(rows)
    for name in ("android-icon-foreground.png", "android-icon-monochrome.png"):
        encode_png(os.path.join(OUT, name), w, h, white, alpha=True)
        print("wrote", name)

    w, h, rows = render_svg(glyph_svg, 1024)
    encode_png(os.path.join(OUT, "splash-icon.png"), w, h, mask_to_white(rows), alpha=True)
    print("wrote splash-icon.png")

    subprocess.run(
        ["sips", "-z", "48", "48", os.path.join(OUT, "icon.png"), "--out", os.path.join(OUT, "favicon.png")],
        check=True,
        capture_output=True,
    )
    print("wrote favicon.png")


if __name__ == "__main__":
    main()
