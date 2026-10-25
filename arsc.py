import struct

from axml import chunk, string_pool

TYPE_STRING = 0x03


def package_name(name):
    raw = name.encode("utf-16-le")
    if len(raw) > 254:
        raise ValueError("package name too long")
    return raw + b"\0" * (256 - len(raw))


def table(package, package_id, types):
    paths = []
    for _, entries in types:
        for _, path in entries:
            paths.append(path)
    type_names = [t for t, _ in types]
    keys = [k for _, entries in types for k, _ in entries]
    body = bytearray()
    type_pool = string_pool(type_names)
    key_pool = string_pool(keys)
    chunks = bytearray()
    key_index = {k: i for i, k in enumerate(keys)}
    ids = {}
    for t_index, (t_name, entries) in enumerate(types, start=1):
        n = len(entries)
        spec = chunk(0x0202, struct.pack("<BBHI", t_index, 0, 0, n), b"\0\0\0\0" * n)
        offsets = bytearray()
        data = bytearray()
        for e_index, (key, path) in enumerate(entries):
            offsets += struct.pack("<I", len(data))
            data += struct.pack("<HHI", 8, 0, key_index[key])
            data += struct.pack("<HBBI", 8, 0, TYPE_STRING, paths.index(path))
            ids[f"{t_name}/{key}"] = (package_id << 24) | (t_index << 16) | e_index
        config = struct.pack("<I", 64) + b"\0" * 60
        header = struct.pack("<BBHII", t_index, 0, 0, n, 8 + 12 + len(config) + len(offsets)) + config
        typ = chunk(0x0201, header, bytes(offsets + data))
        chunks += spec + typ
    pkg_header_len = 8 + 4 + 256 + 4 * 5
    type_off = pkg_header_len
    key_off = type_off + len(type_pool)
    pkg_header = struct.pack("<I", package_id) + package_name(package) + struct.pack(
        "<IIIII", type_off, len(type_names), key_off, len(keys), 0)
    pkg = chunk(0x0200, pkg_header, type_pool + key_pool + bytes(chunks))
    body += string_pool(paths) + pkg
    return chunk(0x0002, struct.pack("<I", 1), bytes(body)), ids
