import struct

ANDROID = "http://schemas.android.com/apk/res/android"

ATTR = {
    "theme": 0x01010000, "label": 0x01010001, "icon": 0x01010002, "name": 0x01010003,
    "exported": 0x01010010, "screenOrientation": 0x0101001e, "configChanges": 0x0101001f,
    "minSdkVersion": 0x0101020c, "versionCode": 0x0101021b, "versionName": 0x0101021c,
    "windowSoftInputMode": 0x0101022b, "targetSdkVersion": 0x01010270, "allowBackup": 0x01010280,
    "usesCleartextTraffic": 0x010104ec, "drawable": 0x01010199,
    "taskAffinity": 0x01010012, "launchMode": 0x0101001d, "dataExtractionRules": 0x0101063e,
}

TYPE_REFERENCE = 0x01
TYPE_STRING = 0x03
TYPE_INT_DEC = 0x10
TYPE_INT_HEX = 0x11
TYPE_INT_BOOLEAN = 0x12


class Ref(int):
    pass


class Hex(int):
    pass


class Element:
    def __init__(self, tag, attrs=(), children=()):
        self.tag, self.attrs, self.children = tag, list(attrs), list(children)


def chunk(typ, header, body):
    size = 8 + len(header) + len(body)
    return struct.pack("<HHI", typ, 8 + len(header), size) + header + body


def string_pool(strings):
    offsets = bytearray()
    data = bytearray()
    for s in strings:
        offsets += struct.pack("<I", len(data))
        u = s.encode("utf-16-le")
        n = len(u) // 2
        if n > 0x7fff:
            raise ValueError("string too long")
        data += struct.pack("<H", n) + u + b"\0\0"
    while len(data) % 4:
        data.append(0)
    header = struct.pack("<IIIII", len(strings), 0, 0, 28 + len(offsets), 0)
    return chunk(0x0001, header, bytes(offsets + data))


def encode(root):
    attr_names = []
    others = []

    def walk(e):
        for name, _ in e.attrs:
            if name.startswith("android:"):
                short = name[8:]
                if short not in ATTR:
                    raise ValueError(f"unknown attribute id for {name}")
                if short not in attr_names:
                    attr_names.append(short)
        for c in e.children:
            walk(c)

    walk(root)
    attr_names.sort(key=lambda n: ATTR[n])

    def add(s):
        if s not in attr_names and s not in others:
            others.append(s)

    add("android")
    add(ANDROID)

    def walk2(e):
        add(e.tag)
        for name, value in e.attrs:
            if not name.startswith("android:"):
                add(name)
            if isinstance(value, str):
                add(value)
        for c in e.children:
            walk2(c)

    walk2(root)
    strings = attr_names + others
    idx = {s: i for i, s in enumerate(strings)}
    out = bytearray()
    out += string_pool(strings)
    out += chunk(0x0180, b"", b"".join(struct.pack("<I", ATTR[n]) for n in attr_names))
    node = lambda typ, ext: chunk(typ, struct.pack("<II", 1, 0xffffffff), ext)
    out += node(0x0100, struct.pack("<II", idx["android"], idx[ANDROID]))

    def emit(e):
        attrs = []
        for name, value in e.attrs:
            if name.startswith("android:"):
                ns, nm = idx[ANDROID], idx[name[8:]]
            else:
                ns, nm = 0xffffffff, idx[name]
            raw = 0xffffffff
            if isinstance(value, bool):
                typ, data = TYPE_INT_BOOLEAN, 0xffffffff if value else 0
            elif isinstance(value, Ref):
                typ, data = TYPE_REFERENCE, int(value)
            elif isinstance(value, Hex):
                typ, data = TYPE_INT_HEX, int(value)
            elif isinstance(value, int):
                typ, data = TYPE_INT_DEC, value & 0xffffffff
            else:
                typ, data, raw = TYPE_STRING, idx[value], idx[value]
            key = ATTR[name[8:]] if name.startswith("android:") else 0xffffffff + 1 + nm
            attrs.append((key, struct.pack("<IIIHBBI", ns, nm, raw, 8, 0, typ, data)))
        attrs.sort(key=lambda a: a[0])
        ext = struct.pack("<IIHHHHHH", 0xffffffff, idx[e.tag], 0x14, 0x14, len(attrs), 0, 0, 0)
        out.extend(node(0x0102, ext + b"".join(a for _, a in attrs)))
        for c in e.children:
            emit(c)
        out.extend(node(0x0103, struct.pack("<II", 0xffffffff, idx[e.tag])))

    emit(root)
    out += node(0x0101, struct.pack("<II", idx["android"], idx[ANDROID]))
    return chunk(0x0003, b"", bytes(out))
