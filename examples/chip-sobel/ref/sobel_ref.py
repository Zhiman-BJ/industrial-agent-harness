#!/usr/bin/env python3
"""Independent reference model for the sobel_top streaming Sobel filter.

Deliberately implemented from the specification, not from the RTL:
- 8-bit grayscale image, raster order, width 3..128, height 3..65535.
- Interior pixels: Gx = (p02 + 2*p12 + p22) - (p00 + 2*p10 + p20)
                   Gy = (p20 + 2*p21 + p22) - (p00 + 2*p01 + p02)
                   magnitude = |Gx| + |Gy|
                   out = 255 if magnitude >= threshold else 0
- Outermost ring of pixels is always 0.
"""
from __future__ import annotations


def sobel_ref(width: int, height: int, threshold: int, pixels: list[int]) -> list[int]:
    if not (3 <= width <= 128):
        raise ValueError(f"width out of range: {width}")
    if not (3 <= height <= 65535):
        raise ValueError(f"height out of range: {height}")
    if not (0 <= threshold <= 255):
        raise ValueError(f"threshold out of range: {threshold}")
    if len(pixels) != width * height:
        raise ValueError("pixel count mismatch")
    if any(p < 0 or p > 255 for p in pixels):
        raise ValueError("pixel value out of range")

    out = [0] * (width * height)
    for r in range(1, height - 1):
        row = r * width
        up = row - width
        dn = row + width
        for c in range(1, width - 1):
            p00 = pixels[up + c - 1]
            p01 = pixels[up + c]
            p02 = pixels[up + c + 1]
            p10 = pixels[row + c - 1]
            p12 = pixels[row + c + 1]
            p20 = pixels[dn + c - 1]
            p21 = pixels[dn + c]
            p22 = pixels[dn + c + 1]
            gx = (p02 + 2 * p12 + p22) - (p00 + 2 * p10 + p20)
            gy = (p20 + 2 * p21 + p22) - (p00 + 2 * p01 + p02)
            mag = abs(gx) + abs(gy)
            out[row + c] = 255 if mag >= threshold else 0
    return out


def self_test() -> None:
    # 3x3 with a bright center: gradient at all interior pixels (only (1,1)).
    img = [0, 0, 0,
           0, 255, 0,
           0, 0, 0]
    got = sobel_ref(3, 3, 128, img)
    # Gx = (0+0+0)-(0+0+0)=0, Gy = (0+0+0)-(0+0+0)=0 at (1,1): symmetric -> 0.
    assert got == [0] * 9, got
    # Left dark / right bright vertical edge, 4x4.
    img = []
    for _r in range(4):
        img += [0, 0, 255, 255]
    got = sobel_ref(4, 4, 1, img)
    # Interior columns 1,2 of rows 1,2.
    # At (r,1): window cols 0..2 -> Gx = (0+2*255+255)-(0+0+0) = 765 -> 255
    # At (r,2): window cols 1..3 -> Gx = (255+2*255+255)-(0+0+0)=1020 -> 255
    for r in (1, 2):
        assert got[r * 4 + 1] == 255 and got[r * 4 + 2] == 255, got
    # Threshold 255: 765 >= 255 and 1020 >= 255 still true; threshold 1021: none.
    got = sobel_ref(4, 4, 1021, img)
    assert all(v == 0 for v in got), got
    print("sobel_ref self-test OK")


if __name__ == "__main__":
    self_test()
