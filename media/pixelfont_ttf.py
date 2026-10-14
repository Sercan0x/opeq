import struct
import sys

UPM = 1000
PX = 100
ADV = 600
ASC = 800
DESC = 200

UPPER = {
    "A": "01110 10001 10001 11111 10001 10001 10001", "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01111 10000 10000 10000 10000 10000 01111", "D": "11110 10001 10001 10001 10001 10001 11110",
    "E": "11111 10000 10000 11110 10000 10000 11111", "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01111 10000 10000 10111 10001 10001 01111", "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "11111 00100 00100 00100 00100 00100 11111", "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001", "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001", "N": "10001 11001 10101 10011 10001 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110", "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101", "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110", "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110", "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 11011 10001", "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 01010 00100 00100 00100 00100", "Z": "11111 00001 00010 00100 01000 10000 11111",
    "0": "01110 10011 10101 10101 10101 11001 01110", "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
    "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "01110 10000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00001 01110",
    "!": "00100 00100 00100 00100 00100 00000 00100", "?": "01110 10001 00001 00110 00100 00000 00100",
    "-": "00000 00000 00000 11111 00000 00000 00000", ".": "00000 00000 00000 00000 00000 00000 00100",
    ",": "00000 00000 00000 00000 00000 00100 01000", "'": "00100 00100 01000 00000 00000 00000 00000",
    ":": "00000 00100 00000 00000 00000 00100 00000", "/": "00001 00001 00010 00100 01000 10000 10000",
    "+": "00000 00100 00100 11111 00100 00100 00000", "&": "01100 10010 10100 01000 10101 10010 01101",
    "(": "00010 00100 01000 01000 01000 00100 00010", ")": "01000 00100 00010 00010 00010 00100 01000",
    "%": "11001 11010 00010 00100 01000 01011 10011", "=": "00000 00000 11111 00000 11111 00000 00000",
    '"': "01010 01010 00000 00000 00000 00000 00000", ";": "00000 00100 00000 00000 00000 00100 01000",
    "#": "01010 11111 01010 01010 01010 11111 01010", "|": "00100 00100 00100 00100 00100 00100 00100",
    "<": "00010 00100 01000 10000 01000 00100 00010", ">": "01000 00100 00010 00001 00010 00100 01000",
    "_": "00000 00000 00000 00000 00000 00000 11111", "*": "00000 10101 01110 11111 01110 10101 00000",
}

LOWER = {
    "a": "00000 00000 01110 00001 01111 10001 01111", "b": "10000 10000 11110 10001 10001 10001 11110",
    "c": "00000 00000 01111 10000 10000 10000 01111", "d": "00001 00001 01111 10001 10001 10001 01111",
    "e": "00000 00000 01110 10001 11111 10000 01111", "f": "00110 01000 11110 01000 01000 01000 01000",
    "g": "00000 00000 01111 10001 10001 10001 01111 00001 11110", "h": "10000 10000 11110 10001 10001 10001 10001",
    "i": "00100 00000 01100 00100 00100 00100 01110", "j": "00010 00000 00110 00010 00010 00010 00010 10010 01100",
    "k": "10000 10000 10010 10100 11000 10100 10010", "l": "01100 00100 00100 00100 00100 00100 01110",
    "m": "00000 00000 11010 10101 10101 10101 10101", "n": "00000 00000 11110 10001 10001 10001 10001",
    "o": "00000 00000 01110 10001 10001 10001 01110", "p": "00000 00000 11110 10001 10001 10001 11110 10000 10000",
    "q": "00000 00000 01111 10001 10001 10001 01111 00001 00001", "r": "00000 00000 10110 11001 10000 10000 10000",
    "s": "00000 00000 01111 10000 01110 00001 11110", "t": "01000 01000 11110 01000 01000 01001 00110",
    "u": "00000 00000 10001 10001 10001 10011 01101", "v": "00000 00000 10001 10001 10001 01010 00100",
    "w": "00000 00000 10001 10001 10101 10101 01010", "x": "00000 00000 10001 01010 00100 01010 10001",
    "y": "00000 00000 10001 10001 10001 10001 01111 00001 01110", "z": "00000 00000 11111 00010 00100 01000 11111",
}


def embolden(rows):
    h, w = len(rows), len(rows[0])
    stem = []
    for c in range(w):
        best = run = 0
        for r in range(h):
            run = run + 1 if rows[r][c] == "1" else 0
            best = max(best, run)
        stem.append(best >= 3)
    return ["".join((ch * 2 if stem[c] else ch) for c, ch in enumerate(row)) for row in rows]


def trim(rows):
    cols = [c for c in range(len(rows[0])) if any(r[c] == "1" for r in rows)]
    if not cols:
        return rows, 0
    a, b = min(cols), max(cols)
    return [r[a:b + 1] for r in rows], b - a + 1


def runs(rows):
    rects = []
    for r, row in enumerate(rows):
        c = 0
        while c < len(row):
            if row[c] == "1":
                s = c
                while c < len(row) and row[c] == "1":
                    c += 1
                top = (7 - r) * PX
                rects.append((s * PX, top - PX, c * PX, top))
            else:
                c += 1
    return rects


def glyph_data(rects):
    if not rects:
        return b"", (0, 0, 0, 0), 0, 0
    pts, ends = [], []
    for x0, y0, x1, y1 in rects:
        pts += [(x0, y0), (x0, y1), (x1, y1), (x1, y0)]
        ends.append(len(pts) - 1)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    out = struct.pack(">hhhhh", len(rects), *bbox)
    out += b"".join(struct.pack(">H", e) for e in ends)
    out += struct.pack(">H", 0)
    out += bytes([0x01]) * len(pts)
    px = py = 0
    xd, yd = b"", b""
    for x, y in pts:
        xd += struct.pack(">h", x - px)
        yd += struct.pack(">h", y - py)
        px, py = x, y
    out += xd + yd
    while len(out) % 4:
        out += b"\0"
    return out, bbox, len(pts), len(rects)


def checksum(data):
    data += b"\0" * ((4 - len(data) % 4) % 4)
    return sum(struct.unpack(f">{len(data) // 4}I", data)) & 0xFFFFFFFF


def build(family="Opeq Pixel", bold=False, proportional=False):
    chars = [chr(c) for c in range(32, 127)]
    glyphs = [(".notdef", runs("11111 10001 10001 10001 10001 10001 11111".split()), ADV)]
    cmap = {}
    for ch in chars:
        src = UPPER.get(ch) or LOWER.get(ch) or UPPER.get(ch.upper())
        if src is None and ch != " ":
            continue
        rows = src.split() if src and ch != " " else []
        width = 5
        if rows:
            rows = [r.ljust(5, "0") for r in rows]
            if bold:
                rows = embolden(rows)
            width = len(rows[0])
            if proportional:
                rows, width = trim(rows)
        else:
            width = 3 if proportional else 5
        cmap[ord(ch)] = len(glyphs)
        glyphs.append((ch, runs(rows) if rows else [], (width + 1) * PX))
    glyf = b""
    loca = [0]
    hmtx = b""
    gb = [0, 0, 0, 0]
    maxp_pts = maxp_cnt = 0
    adv_max = max(g[2] for g in glyphs)
    for _, rects, adv in glyphs:
        data, bbox, npts, ncnt = glyph_data(rects)
        glyf += data
        loca.append(len(glyf))
        hmtx += struct.pack(">Hh", adv, bbox[0])
        if rects:
            gb = [min(gb[0], bbox[0]), min(gb[1], bbox[1]), max(gb[2], bbox[2]), max(gb[3], bbox[3])]
        maxp_pts = max(maxp_pts, npts)
        maxp_cnt = max(maxp_cnt, ncnt)
    n = len(glyphs)
    head = struct.pack(">IIIIHHqqhhhhHHhhh", 0x00010000, 0x00010000, 0, 0x5F0F3CF5, 0x000B, UPM, 0, 0,
                       gb[0], gb[1], gb[2], gb[3], 0, 8, 2, 1, 0)
    hhea = struct.pack(">IhhhHhhhhhhhhhhhH", 0x00010000, ASC, -DESC, 0, adv_max, 0, 0, gb[2], 1, 0, 0, 0, 0, 0, 0, 0, n)
    maxp = struct.pack(">IHHHHHHHHHHHHHH", 0x00010000, n, maxp_pts, maxp_cnt, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)
    os2 = struct.pack(">HhHHHhhhhhhhhhhh", 4, ADV, 400, 5, 0, 650, 700, 0, 140, 650, 700, 0, 480, 50, 300, 0)
    os2 += bytes(10) + struct.pack(">IIII", 1, 0, 0, 0) + b"OPEQ"
    os2 += struct.pack(">HHHhhhHHII", 0x40, 32, 126, ASC, -DESC, 0, ASC, DESC, 1, 0)
    os2 += struct.pack(">hhHHH", 500, 700, 0, 32, 1)
    names = {1: family, 2: "Regular", 3: family.replace(" ", "") + "-Regular-1.0", 4: family + " Regular",
             5: "Version 1.0", 6: family.replace(" ", "") + "-Regular"}
    recs, strs = b"", b""
    for nid, s in names.items():
        e = s.encode("utf-16-be")
        recs += struct.pack(">HHHHHH", 3, 1, 0x409, nid, len(e), len(strs))
        strs += e
    name = struct.pack(">HHH", 0, len(names), 6 + 12 * len(names)) + recs + strs
    codes = sorted(cmap)
    segs = []
    for c in codes:
        if segs and c == segs[-1][1] + 1 and cmap[c] == cmap[segs[-1][1]] + 1:
            segs[-1][1] = c
        else:
            segs.append([c, c])
    segs.append([0xFFFF, 0xFFFF])
    seg_n = len(segs)
    sr = 2 ** (seg_n.bit_length() - 1) * 2
    ends = b"".join(struct.pack(">H", e) for _, e in segs)
    starts = b"".join(struct.pack(">H", s) for s, _ in segs)
    deltas = b"".join(struct.pack(">H", ((cmap[s] - s) % 65536) if s != 0xFFFF else 1) for s, _ in segs)
    ranges = bytes(2 * seg_n)
    sub = struct.pack(">HHHHHHH", 4, 0, 0, seg_n * 2, sr, sr.bit_length() - 2, seg_n * 2 - sr) + ends + b"\0\0" + starts + deltas + ranges
    sub = sub[:2] + struct.pack(">H", len(sub)) + sub[4:]
    cmap_t = struct.pack(">HHHHI", 0, 1, 3, 1, 12) + sub
    post = struct.pack(">IIhhIIIII", 0x00030000, 0, -100, 50, 1, 0, 0, 0, 0)
    loca_t = b"".join(struct.pack(">I", o) for o in loca)
    tables = {b"OS/2": os2, b"cmap": cmap_t, b"glyf": glyf, b"head": head, b"hhea": hhea,
              b"hmtx": hmtx, b"loca": loca_t, b"maxp": maxp, b"name": name, b"post": post}
    tags = sorted(tables)
    nt = len(tags)
    es = nt.bit_length() - 1
    sr2 = (2 ** es) * 16
    out = struct.pack(">IHHHH", 0x00010000, nt, sr2, es, nt * 16 - sr2)
    off = 12 + 16 * nt
    dir_, body = b"", b""
    for t in tags:
        d = tables[t]
        dir_ += struct.pack(">4sIII", t, checksum(d), off + len(body), len(d))
        body += d + b"\0" * ((4 - len(d) % 4) % 4)
    font = bytearray(out + dir_ + body)
    head_off = 12 + 16 * nt + sum(len(tables[t]) + (4 - len(tables[t]) % 4) % 4 for t in tags[:tags.index(b"head")])
    adj = (0xB1B0AFBA - checksum(bytes(font))) & 0xFFFFFFFF
    font[head_off + 8:head_off + 12] = struct.pack(">I", adj)
    return bytes(font), len(cmap)


if __name__ == "__main__":
    bold = "--bold" in sys.argv
    data, count = build("Opeq Pixel Bold" if bold else "Opeq Pixel", bold=bold, proportional=bold)
    open(sys.argv[1], "wb").write(data)
    print(len(data), "bytes,", count, "characters")
