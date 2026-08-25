"""Generate the extension icons without any image library.

Renders each icon at 4x and box-downsamples it, so the rounded corners and the
arrow edges come out smooth. Run from the repo root:  python tools/make_icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor

TOP = (0x5B, 0x95, 0xFF)
BOTTOM = (0x2A, 0x5B, 0xD0)


def inside_round_rect(x, y, size, radius):
    lo, hi = radius, size - radius
    cx = lo if x < lo else (hi if x > hi else x)
    cy = lo if y < lo else (hi if y > hi else y)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= radius * radius


def inside_arrow(u, v):
    """u, v are normalised to 0..1 with v growing downwards."""
    if 0.44 <= u <= 0.56 and 0.20 <= v <= 0.50:
        return True
    if 0.46 <= v <= 0.70:
        half = 0.19 * (0.70 - v) / (0.70 - 0.46)
        if abs(u - 0.5) <= half:
            return True
    if 0.28 <= u <= 0.72 and 0.78 <= v <= 0.86:
        return True
    return False


def render(size):
    big = size * SS
    radius = big * 0.22
    acc = [[[0, 0, 0, 0] for _ in range(size)] for _ in range(size)]

    for y in range(big):
        v = (y + 0.5) / big
        r = round(TOP[0] + (BOTTOM[0] - TOP[0]) * v)
        g = round(TOP[1] + (BOTTOM[1] - TOP[1]) * v)
        b = round(TOP[2] + (BOTTOM[2] - TOP[2]) * v)
        for x in range(big):
            u = (x + 0.5) / big
            if not inside_round_rect(x + 0.5, y + 0.5, big, radius):
                continue
            px = (255, 255, 255, 255) if inside_arrow(u, v) else (r, g, b, 255)
            cell = acc[y // SS][x // SS]
            for i in range(4):
                cell[i] += px[i]

    rows = []
    n = SS * SS
    for row in acc:
        out = bytearray([0])
        for cell in row:
            out += bytes(value // n for value in cell)
        rows.append(bytes(out))
    return b"".join(rows)


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, size, raw):
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        write_png(path, size, render(size))
        print(f"{path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
