#!/usr/bin/env python3
"""Lagar ikon og oppstartsbilete. Svart flate, ein ring av prikkar:
ordna til venstre, oppløyst mot høgre. Same idé som appen: orden som blir til støy.

Bruk:  python3 scripts/make_icons.py
Krev:  pip install pillow
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_ICONS = ROOT / "static" / "icons"
OUT_SPLASH = ROOT / "static" / "splash"
SS = 4  # supersampling


def mark(size: int, scale: float = 1.0) -> Image.Image:
    """Teiknar merket på svart bakgrunn. scale < 1 gir ekstra luft (maskable)."""
    n = size * SS
    img = Image.new("RGB", (n, n), (0, 0, 0))
    d = ImageDraw.Draw(img)
    rnd = random.Random(7)
    cx = cy = n / 2
    R = n * 0.30 * scale
    dots = 56
    base = n * 0.0145 * scale
    for i in range(dots):
        a = (i / dots) * math.tau - math.pi / 2  # start øvst, med klokka
        # x-posisjon frå -1 (venstre) til +1 (høgre)
        x = math.cos(a)
        # 0 til venstre, veks mot høgre
        k = max(0.0, (x + 0.15) / 1.15)
        k = k**1.6
        r = R
        ang = a
        s = base
        keep = True
        if k > 0:
            r += rnd.gauss(0, 1) * R * 0.13 * k
            ang += rnd.gauss(0, 1) * 0.16 * k
            s = base * (1 + rnd.gauss(0, 1) * 0.4 * k)
            s = max(base * 0.35, s)
            keep = rnd.random() > 0.38 * k**1.3
        if not keep:
            continue
        px = cx + r * math.cos(ang)
        py = cy + r * math.sin(ang)
        d.ellipse((px - s, py - s, px + s, py + s), fill=(255, 255, 255))
    # lause prikkar som har rømt frå ringen, til høgre
    for _ in range(14):
        a = rnd.uniform(-1.1, 1.1)
        r = R * rnd.uniform(1.18, 1.5)
        s = base * rnd.uniform(0.3, 0.7)
        px = cx + r * math.cos(a)
        py = cy + r * math.sin(a)
        d.ellipse((px - s, py - s, px + s, py + s), fill=(255, 255, 255))
    # lite kvadrat i midten, som i søkjaren
    q = n * 0.034 * scale
    w = max(SS, int(n * 0.0042 * scale))
    d.rectangle((cx - q, cy - q, cx + q, cy + q), outline=(255, 255, 255), width=w)
    return img.resize((size, size), Image.LANCZOS)


def splash(w: int, h: int) -> Image.Image:
    img = Image.new("RGB", (w, h), (0, 0, 0))
    m = mark(int(min(w, h) * 0.42), 1.0)
    img.paste(m, ((w - m.width) // 2, (h - m.height) // 2 - int(h * 0.02)))
    return img


def main() -> None:
    OUT_ICONS.mkdir(parents=True, exist_ok=True)
    OUT_SPLASH.mkdir(parents=True, exist_ok=True)
    mark(180, 1.12).save(OUT_ICONS / "apple-touch-icon.png", optimize=True)
    mark(192, 1.12).save(OUT_ICONS / "icon-192.png", optimize=True)
    mark(512, 1.12).save(OUT_ICONS / "icon-512.png", optimize=True)
    mark(512, 0.78).save(OUT_ICONS / "icon-maskable-512.png", optimize=True)
    mark(32, 1.2).save(OUT_ICONS / "favicon-32.png", optimize=True)
    for w, h in [
        (1170, 2532),  # 16e, 15, 14, 13, 12
        (1179, 2556),  # 16, 15 Pro
        (1206, 2622),  # 16 Pro
        (1290, 2796),  # 15 Plus, 14 Pro Max
        (1320, 2868),  # 16 Pro Max
        (1125, 2436),  # X, XS, 11 Pro
    ]:
        splash(w, h).save(OUT_SPLASH / f"{w}x{h}.png", optimize=True)
    print("ok")


if __name__ == "__main__":
    main()
