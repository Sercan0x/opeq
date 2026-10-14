import os
import struct
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bonk import lzw_encode

W, H = 960, 540
TRANSPARENT = 255


def load(path):
    data = open(path, "rb").read()
    assert len(data) == W * H * 3
    return data


def median_cut(counts, n):
    boxes = [list(counts.items())]
    while len(boxes) < n:
        best, spread = None, -1
        for i, box in enumerate(boxes):
            if len(box) < 2:
                continue
            for ch in range(3):
                vals = [c[ch] for c, _ in box]
                s = (max(vals) - min(vals)) * (sum(w for _, w in box) ** 0.5)
                if s > spread:
                    best, spread, axis = i, s, ch
        if best is None:
            break
        box = sorted(boxes.pop(best), key=lambda e: e[0][axis])
        total, acc, cut = sum(w for _, w in box), 0, 1
        for k, (_, w) in enumerate(box):
            acc += w
            if acc >= total / 2:
                cut = max(1, min(len(box) - 1, k + 1))
                break
        boxes += [box[:cut], box[cut:]]
    pal = []
    for box in boxes:
        t = sum(w for _, w in box)
        pal.append(tuple(round(sum(c[ch] * w for c, w in box) / t) for ch in range(3)))
    return pal


def build_palette(frames):
    counts = Counter()
    for data in frames[::3]:
        for i in range(0, len(data), 3 * 7):
            counts[data[i:i + 3]] += 1
    pal = median_cut(counts, 255)
    while len(pal) < 255:
        pal.append((0, 0, 0))
    return pal


class Mapper:
    def __init__(self, pal):
        self.pal = pal
        self.cache = {}

    def index(self, key):
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        r, g, b = key
        best, bd = 0, 1 << 30
        for i, (pr, pg, pb) in enumerate(self.pal):
            d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2
            if d < bd:
                best, bd = i, d
        self.cache[key] = best
        return best

    def frame(self, data):
        get = self.cache.get
        out = bytearray(W * H)
        for p in range(W * H):
            key = data[3 * p:3 * p + 3]
            v = get(key)
            out[p] = v if v is not None else self.index(key)
        return out


def block(idx, prev):
    if prev is None:
        return 0, 0, W, H, bytes(idx)
    x0, y0, x1, y1 = W, H, -1, -1
    for y in range(H):
        row = y * W
        a, b = idx[row:row + W], prev[row:row + W]
        if a == b:
            continue
        xs = [x for x in range(W) if a[x] != b[x]]
        x0, x1 = min(x0, xs[0]), max(x1, xs[-1])
        y0, y1 = min(y0, y), y
    if x1 < 0:
        return 0, 0, 1, 1, bytes([TRANSPARENT])
    out = bytearray()
    for y in range(y0, y1 + 1):
        row = y * W
        for x in range(x0, x1 + 1):
            v = idx[row + x]
            out.append(TRANSPARENT if v == prev[row + x] else v)
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1, bytes(out)


def write(path, pal, indexed, delays):
    out = bytearray(b"GIF89a")
    out += struct.pack("<HHBBB", W, H, 0xF7, 0, 0)
    for r, g, b in pal + [(0, 0, 0)]:
        out += bytes([r, g, b])
    out += b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"
    prev = None
    for idx, delay in zip(indexed, delays):
        x, y, w, h, px = block(idx, prev)
        flags = 0x05 if prev is not None else 0x04
        out += b"\x21\xF9\x04" + bytes([flags]) + struct.pack("<H", delay) + bytes([TRANSPARENT]) + b"\x00"
        out += b"\x2C" + struct.pack("<HHHHB", x, y, w, h, 0)
        data = lzw_encode(px, 8)
        out += b"\x08"
        for i in range(0, len(data), 255):
            chunk = data[i:i + 255]
            out += bytes([len(chunk)]) + chunk
        out += b"\x00"
        prev = idx
    out += b"\x3B"
    open(path, "wb").write(out)
    return len(out)


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    names = sorted(n for n in os.listdir(src) if n.endswith(".rgb"))
    frames = [load(os.path.join(src, n)) for n in names]
    pal = build_palette(frames)
    mapper = Mapper(pal)
    indexed = []
    for k, data in enumerate(frames):
        indexed.append(mapper.frame(data))
        if k % 20 == 0:
            print("mapped", k, "cache", len(mapper.cache), flush=True)
    step = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    delays = [step] * len(frames)
    delays[-1] = 250
    size = write(dst, pal, indexed, delays)
    print("frames", len(frames), "bytes", size)
