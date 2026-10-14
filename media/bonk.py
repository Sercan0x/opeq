import math
import struct
import sys
import zlib

W, H = 192, 108
SCALE = 5

PALETTE = [
    (0x0b, 0x0e, 0x13),
    (0x16, 0x1c, 0x25),
    (0xee, 0xf1, 0xf5),
    (0x3a, 0xd0, 0xff),
    (0x1c, 0x7f, 0xa8),
    (0x2b, 0x35, 0x44),
    (0x45, 0x52, 0x66),
    (0x9a, 0xa6, 0xb8),
    (0xff, 0x4d, 0x5e),
    (0x8b, 0x6c, 0xff),
    (0x55, 0x3c, 0xc4),
    (0xff, 0xd8, 0x4d),
    (0x26, 0x2f, 0x3d),
    (0x6b, 0x77, 0x8a),
    (0xff, 0xff, 0xff),
    (0x0f, 0x13, 0x1a),
]
INK, GROUND_C, PAPER, ICE, ICE_D, STEEL, STEEL_L, METAL, RED, VIOLET, VIOLET_D, YELLOW, STAR_BG, GRAY, WHITE, BG2 = range(16)

SAFE = [
    "..IIIIIIIIIIIIIIIIIIII..",
    ".ISSSSSSSSSSSSSSSSSSSSI.",
    "ISSSSSSSSSSSSSSSSSSSSSSI",
    "ISSDDDDDDDDDDDDDDDDDDSSI",
    "ISSDLLLLLLLLLLLLLLLLDSSI",
    "ISSDLWWWLLLLLLLLWWWLDSSI",
    "ISSDLWKWLLLLLLLLWKWLDSSI",
    "ISSDLWWWLLLLLLLLWWWLDSSI",
    "ISSDLLLLLLLLLLLLLLLLDSSI",
    "ISSDLLLLLLLPPLLLLLLLDSSI",
    "ISSDLLLLLLLPPLLLLLLLDSSI",
    "ISSDLLLLLLLLLLLLLLLLDSSI",
    "ISSDLLLOOLLLLLLPPLLLDSSI",
    "ISSDLLLOOLLLLLLPPLLLDSSI",
    "ISSDLLLLLLLLLLLLLLLLDSSI",
    "ISSDLOOLLOOLLCCLLOOLDSSI",
    "ISSDLOOLLOOLLCCLLOOLDSSI",
    "ISSDLLLLLLLLLLLLLLLLDSSI",
    "ISSDDDDDDDDDDDDDDDDDDSSI",
    "ISSSSSSSSSSSSSSSSSSSSSSI",
    ".ISSSSSSSSSSSSSSSSSSSSI.",
    "..IIIIIIIIIIIIIIIIIIII..",
    "...II..............II...",
    "..III..............III..",
]
SAFE_MAP = {"I": ICE, "S": STEEL, "D": STEEL_L, "L": STEEL, "W": WHITE, "K": INK, "P": PAPER, "O": PAPER, "C": ICE}

ROBOT = [
    ".......r........",
    ".......g........",
    "..gggggggggggg..",
    "..gMMMMMMMMMMg..",
    "..gMRRRMMRRRMg..",
    "..gMRRRMMRRRMg..",
    "..gMRRRMMRRRMg..",
    "..gMMMMMMMMMMg..",
    "..gMMwwwwwwMMg..",
    "..gggggggggggg..",
    "....gggggggg....",
    "..gggggggggggg..",
    ".gMMMMMMMMMMMMg.",
    "gMgMMMMMMMMMMgMg",
    "gMgMMMrrrrMMMgMg",
    "gMgMMMMMMMMMMgMg",
    ".ggMMMMMMMMMMgg.",
    "..gggggggggggg..",
    "...gg......gg...",
    "..ggg......ggg..",
]
ROBOT_MAP = {"r": RED, "g": STEEL_L, "M": METAL, "R": RED, "w": INK}
ROBOT_EYES = [(4, 4), (4, 9)]

QC = [
    ".......vv.......",
    ".......vv.......",
    "...pppppppppp...",
    "....v..vv..v....",
    "....v..vv..v....",
    "..pppppppppppp..",
    "...v..v..v..v...",
    "...v..v..v..v...",
    ".pppppppppppppp.",
    "..v...v..v...v..",
    "..v...v..v...v..",
    "..pppppppppppp..",
    "..pRRRppppRRRp..",
    "..pRRRppppRRRp..",
    "..pRRRppppRRRp..",
    "...pppppppppp...",
    "......pppp......",
]
QC_MAP = {"v": VIOLET, "p": VIOLET_D, "R": RED}
QC_EYES = [(12, 3), (12, 10)]

FONT = {
    "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
    "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
    "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
    "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
    "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
    "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
    "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
    "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
    "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
    "?": ["01110", "10001", "00001", "00110", "00100", "00000", "00100"],
    " ": ["00000"] * 7,
    "o": ["00000", "00000", "01110", "10001", "10001", "10001", "01110", "00000", "00000"],
    "p": ["00000", "00000", "11110", "10001", "10001", "10001", "11110", "10000", "10000"],
    "e": ["00000", "00000", "01110", "10001", "11111", "10000", "01111", "00000", "00000"],
    "q": ["00000", "00000", "01111", "10001", "10001", "10001", "01111", "00001", "00001"],
}


class Canvas:
    def __init__(self):
        self.px = bytearray(W * H)

    def set(self, x, y, c):
        x, y = int(round(x)), int(round(y))
        if 0 <= x < W and 0 <= y < H:
            self.px[y * W + x] = c

    def rect(self, x, y, w, h, c):
        for j in range(h):
            for i in range(w):
                self.set(x + i, y + j, c)

    def sprite(self, rows, mapping, x, y, squash=1.0, overrides=None, k=2):
        h = len(rows) * k
        nh = max(1, int(round(h * squash)))
        top = y + (h - nh)
        for j in range(nh):
            sr = min(len(rows) - 1, int(j * h / nh) // k)
            src = rows[sr]
            for i, ch in enumerate(src):
                if ch == ".":
                    continue
                c = mapping[ch]
                if overrides and (sr, i) in overrides:
                    c = overrides[(sr, i)]
                for d in range(k):
                    self.set(x + i * k + d, top + j, c)

    def text(self, s, x, y, c, scale=1, outline=None):
        if outline is not None:
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
                self.text(s, x + dx, y + dy, outline, scale)
        cx = x
        for ch in s:
            g = FONT[ch]
            for j, row in enumerate(g):
                for i, b in enumerate(row):
                    if b == "1":
                        self.rect(cx + i * scale, y + j * scale, scale, scale, c)
            cx += 6 * scale
        return cx - x

    def text_width(self, s, scale=1):
        return len(s) * 6 * scale - scale


def text_center(cv, s, y, c, scale=1, outline=None):
    cv.text(s, (W - cv.text_width(s, scale)) // 2, y, c, scale, outline)


def background(cv):
    for y in range(H):
        for x in range(W):
            cv.px[y * W + x] = BG2 if (x // 8 + y // 8) % 2 == 0 else INK
    for x in range(W):
        for y in range(GROUND, H):
            cv.px[y * W + x] = GROUND_C
        cv.set(x, GROUND, STEEL)
    for k in range(0, W, 12):
        cv.set(k + 3, GROUND + 5, STEEL)
        cv.set(k + 9, GROUND + 10, STEEL)


def merkle_icon(cv, x, y, s=2):
    cells = [(1.5, 0, PAPER), (0.5, 1, None), (2.5, 1, PAPER), (0, 2, None), (1, 2, None), (2, 2, ICE), (3, 2, None)]
    for cx, cy, c in cells:
        px, py = x + int(cx * 4 * s), y + cy * 4 * s
        if c is None:
            for i in range(3 * s):
                cv.set(px + i, py, PAPER)
                cv.set(px + i, py + 3 * s - 1, PAPER)
                cv.set(px, py + i, PAPER)
                cv.set(px + 3 * s - 1, py + i, PAPER)
        else:
            cv.rect(px, py, 3 * s, 3 * s, c)


def hammer(cv, px, py, ang, length=40):
    d = (math.cos(ang), math.sin(ang))
    n = (-d[1], d[0])
    t = 0.0
    while t <= length:
        w = -2.0
        while w <= 2.0:
            cv.set(px + d[0] * t + n[0] * w, py + d[1] * t + n[1] * w, STEEL_L if abs(w) < 1 else METAL)
            w += 0.5
        t += 0.3
    for edge in (True, False):
        u = -8.0
        while u <= 8:
            v = -12.0
            while v <= 12:
                rim = abs(u) > 6.6 or abs(v) > 10.6
                if rim == edge:
                    c = INK if rim else (ICE if -2 <= v <= 2 else PAPER)
                    cv.set(px + d[0] * (length + u) + n[0] * v, py + d[1] * (length + u) + n[1] * v, c)
                v += 0.3
            u += 0.3


def stars(cv, cx, cy, phase, r=9):
    for k in range(3):
        a = phase + k * 2 * math.pi / 3
        x, y = cx + r * math.cos(a), cy + 0.4 * r * math.sin(a)
        for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
            cv.set(x + dx, y + dy, YELLOW)


def burst(cv, cx, cy, r):
    for k in range(8):
        a = k * math.pi / 4
        for t in range(r - 4, r):
            cv.set(cx + t * math.cos(a), cy + t * math.sin(a), YELLOW)


def dazed_eyes(eyes, base):
    o = {}
    for r0, c0 in eyes:
        for dr in range(3):
            for dc in range(3):
                o[(r0 + dr, c0 + dc)] = INK if (dr == dc or dr + dc == 2) else base
    return o


def lerp(a, b, t):
    return a + (b - a) * max(0.0, min(1.0, t))


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


GROUND = 96
SAFE_X, SAFE_Y = 72, GROUND - 48
PIVOT = (SAFE_X + 24, SAFE_Y - 1)
AI_STOP, QC_STOP = 18, 142
QC_Y = 24
UP = -math.pi / 2
AI_T = (AI_STOP + 16, GROUND - 40 - 8)
QC_T = (QC_STOP + 16, QC_Y - 8)
HIT_AI = math.atan2(AI_T[1] - PIVOT[1], AI_T[0] - PIVOT[0]) - 2 * math.pi
HIT_QC = math.atan2(QC_T[1] - PIVOT[1], QC_T[0] - PIVOT[0])
L_AI = math.dist(PIVOT, AI_T)
L_QC = math.dist(PIVOT, QC_T)
FRAMES = 104


def frame(f):
    cv = Canvas()
    background(cv)
    blink = f % 40 in (0, 1)
    look = 0
    if 14 <= f < 40:
        look = -1 if (f // 6) % 2 == 0 else 1
    over = {}
    if blink:
        for r, c in ((5, 5), (5, 6), (5, 7), (6, 5), (6, 6), (6, 7), (7, 5), (7, 6), (7, 7), (5, 16), (5, 17), (5, 18), (6, 16), (6, 17), (6, 18), (7, 16), (7, 17), (7, 18)):
            over[(r, c)] = STEEL
        for c in (5, 6, 7, 16, 17, 18):
            over[(6, c)] = INK
    elif look:
        for c0 in (5, 16):
            over[(6, c0 + 1)] = WHITE
            over[(6, c0 + 1 + look)] = INK
    cv.sprite(SAFE, SAFE_MAP, SAFE_X, SAFE_Y, overrides=over)

    ai_x = lerp(-36, AI_STOP, ease((f - 10) / 26))
    qc_x = lerp(W + 4, QC_STOP, ease((f - 12) / 26))
    if f >= 66:
        ai_x = lerp(AI_STOP, -40, ease((f - 66) / 12))
        qc_x = lerp(QC_STOP, W + 40, ease((f - 68) / 12))
    qc_y = QC_Y + (0 if 54 <= f < 66 else 2 * math.sin(f / 3))

    ai_squash = 1.0
    if 46 <= f < 50:
        ai_squash = 0.6
    elif 50 <= f < 54:
        ai_squash = 0.8
    qc_squash = 1.0
    if 58 <= f < 62:
        qc_squash = 0.6
    elif 62 <= f < 65:
        qc_squash = 0.8

    ai_dazed = 46 <= f < 78
    qc_dazed = 58 <= f < 80
    ai_over = dazed_eyes(ROBOT_EYES, METAL) if ai_dazed else None
    qc_over = dazed_eyes(QC_EYES, VIOLET_D) if qc_dazed else None
    hop = -2 if (f // 3) % 2 and 10 < f < 36 else 0
    if f < 80:
        cv.sprite(ROBOT, ROBOT_MAP, ai_x, GROUND - 40 + hop, ai_squash, ai_over)
        cv.sprite(QC, QC_MAP, qc_x, qc_y, qc_squash, qc_over)
        if 16 <= f < 46:
            cv.text("AI", int(ai_x) + 10, GROUND - 52, RED, 1, INK)
            cv.text("QUANTUM", int(qc_x) - 4, int(qc_y) - 11, VIOLET, 1, INK)
        if 30 <= f < 42 and (f // 2) % 2 == 0:
            cv.text("?", int(ai_x) + 34, GROUND - 46, YELLOW, 1, INK)
            cv.text("?", int(qc_x) - 8, int(qc_y) + 4, YELLOW, 1, INK)
        if ai_dazed and f >= 50:
            stars(cv, ai_x + 16, GROUND - 44 + (40 - 40 * ai_squash), f / 2, 14)
        if qc_dazed and f >= 62:
            stars(cv, qc_x + 16, qc_y - 4 + (32 - 32 * qc_squash), f / 2, 14)

    ang = None
    if 36 <= f < 42:
        ang = UP
        length = lerp(4, L_AI, (f - 36) / 5)
    elif 42 <= f < 46:
        ang, length = lerp(UP, HIT_AI, ease((f - 41) / 4)), L_AI
    elif 46 <= f < 52:
        tgt = (AI_T[0], GROUND - 40 * ai_squash - 8)
        ang = math.atan2(tgt[1] - PIVOT[1], tgt[0] - PIVOT[0]) - 2 * math.pi
        length = math.dist(PIVOT, tgt)
    elif 52 <= f < 58:
        t = ease((f - 51) / 6)
        ang, length = lerp(HIT_AI, HIT_QC, t), lerp(L_AI, L_QC, t)
    elif 58 <= f < 64:
        tgt = (QC_T[0], qc_y + len(QC) * 2 * (1 - qc_squash) - 8)
        ang = math.atan2(tgt[1] - PIVOT[1], tgt[0] - PIVOT[0])
        length = math.dist(PIVOT, tgt)
    elif 64 <= f < 72:
        ang, length = lerp(HIT_QC, UP, ease((f - 63) / 8)), lerp(L_QC, 4, (f - 66) / 6)
    if ang is not None and length > 5:
        hammer(cv, PIVOT[0], PIVOT[1], ang, length)

    if 46 <= f < 52:
        burst(cv, AI_T[0], AI_T[1] + 8, 18 + (f - 46))
        cv.text("BONK!", 6, 8, YELLOW, 2, INK)
    if 58 <= f < 64:
        burst(cv, QC_T[0], QC_T[1] + 8, 18 + (f - 58))
        cv.text("BONK!", 128, 62, YELLOW, 2, INK)

    if f >= 80:
        t = ease((f - 80) / 8)
        cv.rect(0, 0, W, int(44 * t), INK)
        if f >= 86:
            text_center(cv, "QUANTUM-PROOF WALLETS", 6, PAPER, 1)
        if f >= 90:
            merkle_icon(cv, 55, 17, 2)
            cv.text("opeq", 91, 19, PAPER, 2)
    elif f < 10:
        text_center(cv, "opeq", 10, PAPER, 2)
    return cv


def lzw_encode(indices, min_size=4):
    clear, eoi = 1 << min_size, (1 << min_size) + 1
    size = min_size + 1
    table = {bytes([i]): i for i in range(clear)}
    nxt = eoi + 1
    out, bitbuf, nbits = bytearray(), 0, 0

    def emit(code):
        nonlocal bitbuf, nbits
        bitbuf |= code << nbits
        nbits += size
        while nbits >= 8:
            out.append(bitbuf & 0xFF)
            bitbuf >>= 8
            nbits -= 8

    emit(clear)
    w = b""
    for k in indices:
        wk = w + bytes([k])
        if wk in table:
            w = wk
            continue
        emit(table[w])
        if nxt < 4096:
            table[wk] = nxt
            nxt += 1
            if nxt > (1 << size) and size < 12:
                size += 1
        else:
            emit(clear)
            table = {bytes([i]): i for i in range(clear)}
            nxt = eoi + 1
            size = min_size + 1
        w = bytes([k])
    if w:
        emit(table[w])
    emit(eoi)
    if nbits:
        out.append(bitbuf & 0xFF)
    return bytes(out)


def scaled(px, s):
    out = bytearray()
    for y in range(H):
        row = bytearray()
        for x in range(W):
            row += bytes([px[y * W + x]]) * s
        out += bytes(row) * s
    return bytes(out)


def write_gif(path, frames, delay_cs):
    sw, sh = W * SCALE, H * SCALE
    out = bytearray(b"GIF89a")
    out += struct.pack("<HHBBB", sw, sh, 0xF3, 0, 0)
    for r, g, b in PALETTE:
        out += bytes([r, g, b])
    out += b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00"
    for px, delay in zip(frames, delay_cs):
        out += b"\x21\xF9\x04\x04" + struct.pack("<H", delay) + b"\x00\x00"
        out += b"\x2C" + struct.pack("<HHHHB", 0, 0, sw, sh, 0)
        data = lzw_encode(scaled(px, SCALE))
        out += b"\x04"
        for i in range(0, len(data), 255):
            chunk = data[i:i + 255]
            out += bytes([len(chunk)]) + chunk
        out += b"\x00"
    out += b"\x3B"
    open(path, "wb").write(out)


def write_png(path, px, s=SCALE):
    raw = scaled(px, s)
    w, h = W * s, H * s
    rows = b"".join(b"\x00" + bytes(c for i in raw[y * w:(y + 1) * w] for c in PALETTE[i]) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    frames = [frame(f).px for f in range(FRAMES)]
    delays = [8] * FRAMES
    delays[-1] = 250
    for i in (46, 58):
        delays[i] = 16
    if len(sys.argv) > 2:
        for f in map(int, sys.argv[2].split(",")):
            write_png(sys.argv[1].replace(".gif", f"-f{f}.png"), frames[f])
    write_gif(sys.argv[1], frames, delays)
    print("frames", FRAMES)
