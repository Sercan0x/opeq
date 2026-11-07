import hashlib
import io
import os
import struct
import sys
import tempfile
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import apk
import build_android as B


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        check.failed += 1


check.failed = 0


def uleb(b, i):
    r = s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7f) << s
        s += 7
        if not x & 0x80:
            return r, i


def parse_dex(d):
    h = struct.unpack_from("<8sI20sIIIIII" + "I" * 14, d, 0)
    names = ["magic", "checksum", "sig", "size", "hsize", "endian", "link_size", "link_off", "map_off",
             "str_n", "str_off", "type_n", "type_off", "proto_n", "proto_off", "field_n", "field_off",
             "meth_n", "meth_off", "cls_n", "cls_off", "data_size", "data_off"]
    H = dict(zip(names, h))
    strs = []
    for k in range(H["str_n"]):
        o = struct.unpack_from("<I", d, H["str_off"] + 4 * k)[0]
        _, i = uleb(d, o)
        strs.append(d[i:d.index(b"\0", i)].decode())
    types = [strs[struct.unpack_from("<I", d, H["type_off"] + 4 * k)[0]] for k in range(H["type_n"])]
    protos = []
    for k in range(H["proto_n"]):
        _, rt, po = struct.unpack_from("<III", d, H["proto_off"] + 12 * k)
        ps = []
        if po:
            n = struct.unpack_from("<I", d, po)[0]
            ps = [types[struct.unpack_from("<H", d, po + 4 + 2 * j)[0]] for j in range(n)]
        protos.append((types[rt], ps))
    meths = []
    for k in range(H["meth_n"]):
        c, p, n = struct.unpack_from("<HHI", d, H["meth_off"] + 8 * k)
        meths.append((types[c], strs[n], protos[p]))
    maps = []
    n = struct.unpack_from("<I", d, H["map_off"])[0]
    for k in range(n):
        maps.append(struct.unpack_from("<HHII", d, H["map_off"] + 4 + 12 * k))
    code = {}
    for k in range(H["cls_n"]):
        ci, _, _, _, _, _, cdo, _ = struct.unpack_from("<IIIIIIII", d, H["cls_off"] + 32 * k)
        i = cdo
        sf, i = uleb(d, i)
        inf, i = uleb(d, i)
        dm, i = uleb(d, i)
        vm, i = uleb(d, i)
        for _ in range(sf + inf):
            _, i = uleb(d, i)
            _, i = uleb(d, i)
        for cnt in (dm, vm):
            idx = 0
            for _ in range(cnt):
                diff, i = uleb(d, i)
                idx += diff
                acc, i = uleb(d, i)
                co, i = uleb(d, i)
                regs, ins, outs, tries, _, nu = struct.unpack_from("<HHHHII", d, co)
                units = struct.unpack_from("<%dH" % nu, d, co + 16)
                code[meths[idx][:2]] = (meths[idx], acc, regs, ins, outs, units)
    return H, strs, meths, maps, code


SIZES = {0x1a: 2, 0x22: 2, 0x1f: 2, 0x38: 2, 0x39: 2, 0x54: 2, 0x5b: 2, 0x13: 2, 0x14: 3,
         0x0e: 1, 0x0a: 1, 0x0c: 1, 0x0d: 1, 0x0f: 1, 0x11: 1, 0x12: 1, 0x28: 1}
INVOKES = {0x6e, 0x6f, 0x70, 0x71, 0x72}


def walk(meths, entry):
    m, acc, regs, ins, outs, units = entry
    argc = len(m[2][1]) + (0 if acc & 8 else 1)
    ok = ins == argc
    j = 0
    most = 0
    consts = []
    while j < len(units):
        op = units[j] & 0xff
        if op in INVOKES:
            cnt = units[j] >> 12
            tm = meths[units[j + 1]]
            want = len(tm[2][1]) + (0 if op == 0x71 else 1)
            regs_used = [(units[j + 2] >> (4 * q)) & 0xf for q in range(4)][:cnt]
            ok = ok and cnt == want and all(r < regs for r in regs_used)
            most = max(most, cnt)
            j += 3
        elif op in SIZES:
            if op == 0x13:
                consts.append(units[j + 1])
            j += SIZES[op]
        else:
            return False, consts
    return ok and most == outs, consts


for secure in (True, False):
    d = B.shell(secure)
    H, strs, meths, maps, code = parse_dex(d)
    label = "release" if secure else "test"
    check(f"{label} dex: magic, size, checksum and signature",
          d[:8] == b"dex\n035\0" and H["size"] == len(d) and H["checksum"] == zlib.adler32(d[12:])
          and d[12:32] == hashlib.sha1(d[32:]).digest())
    check(f"{label} dex: strings sorted, map offsets increasing",
          strs == sorted(strs) and all(a[3] < b[3] for a, b in zip(maps, maps[1:])))
    check(f"{label} dex: every method decodes with matching ins, outs and invoke arity",
          all(walk(meths, e)[0] for e in code.values()))
    flags = walk(meths, code[(B.MAIN, "onCreate")])[1]
    check(f"{label} dex: FLAG_SECURE {'set' if secure else 'off'}", (B.FLAG_SECURE in flags) == secure)
    check(f"{label} dex: no JavaScript interface", "addJavascriptInterface" not in strs)
    check(f"{label} dex: asset paths with '..' are refused", ".." in strs and "contains" in strs)


def axml_tree(b):
    i = 8
    strings, ids, out, depth = [], [], [], 0
    while i < len(b):
        t, _, sz = struct.unpack_from("<HHI", b, i)
        if t == 1:
            n, _, _, ss, _ = struct.unpack_from("<IIIII", b, i + 8)
            for k in range(n):
                o = struct.unpack_from("<I", b, i + 28 + 4 * k)[0]
                p = i + ss + o
                ln = struct.unpack_from("<H", b, p)[0]
                strings.append(b[p + 2:p + 2 + 2 * ln].decode("utf-16-le"))
        elif t == 0x180:
            ids = list(struct.unpack_from("<%dI" % ((sz - 8) // 4), b, i + 8))
        elif t == 0x102:
            _, nm, ast, _, ac = struct.unpack_from("<IIHHH", b, i + 16)
            attrs = {}
            for k in range(ac):
                _, a_nm, _, _, _, typ, data = struct.unpack_from("<IIIHBBI", b, i + 16 + ast + 20 * k)
                attrs[strings[a_nm]] = strings[data] if typ == 3 else data
            out.append((depth, strings[nm], attrs))
            depth += 1
        elif t == 0x103:
            depth -= 1
        i += sz
    return out


res, icon = B.icon_resources()
tree = axml_tree(B.manifest(1, "1.0.0", "OPEQ", icon))
tags = [(t, a) for _, t, a in tree]
first = dict(tags)
check("manifest: package, sdk levels and a single INTERNET permission",
      first["manifest"]["package"] == B.PACKAGE and first["uses-sdk"]["minSdkVersion"] == 26
      and [a["name"] for t, a in tags if t == "uses-permission"] == ["android.permission.INTERNET"])
check("manifest: no backup, no cleartext, icon points into the resource table",
      first["application"]["allowBackup"] == 0 and first["application"]["usesCleartextTraffic"] == 0
      and first["application"]["icon"] == icon and icon >> 24 == 0x7f)
check("manifest: one exported launcher activity",
      first["activity"]["name"] == "io.opeq.wallet.Main" and first["activity"]["exported"] == 0xffffffff
      and any(t == "category" and a["name"] == "android.intent.category.LAUNCHER" for t, a in tags))

files = dict(res)
table = files["resources.arsc"]
t, hs, size = struct.unpack_from("<HHI", table, 0)
check("arsc: table header and size", t == 2 and size == len(table))
check("arsc: every drawable file it names is in the package",
      all(p in files for p in ("res/drawable/bg.png", "res/drawable/fg.png", "res/drawable/ic.xml")))
check("icon: foreground is a 432 px PNG", files["res/drawable/fg.png"][:8] == b"\x89PNG\r\n\x1a\n"
      and struct.unpack(">II", files["res/drawable/fg.png"][16:24]) == (432, 432))

with tempfile.TemporaryDirectory() as tmp:
    key = os.path.join(tmp, "k.pem")
    apk.new_key(key, "test")
    k, cert = apk.load_key(key)
    entries = [("AndroidManifest.xml", B.manifest(1, "1.0.0", "OPEQ", icon)), ("classes.dex", B.shell())] + res
    entries.append(("assets/app.html", b"<!doctype html><title>t</title>"))
    stored = {"resources.arsc", "res/drawable/bg.png", "res/drawable/fg.png"}
    out = apk.build(entries, stored, k, cert)
    check("apk: v2 signature verifies", bool(apk.verify(out)))
    z = zipfile.ZipFile(io.BytesIO(out))
    aligned = True
    for info in z.infolist():
        if info.compress_type == 0:
            nlen, xlen = struct.unpack_from("<HH", out, info.header_offset + 26)
            aligned = aligned and (info.header_offset + 30 + nlen + xlen) % 4 == 0
    check("apk: zip reads back and stored entries are 4-byte aligned", z.testzip() is None and aligned)
    bad = bytearray(out)
    bad[z.getinfo("assets/app.html").header_offset + 40] ^= 1
    try:
        apk.verify(bytes(bad))
        check("apk: a changed byte breaks the signature", False)
    except Exception:
        check("apk: a changed byte breaks the signature", True)

src = os.path.join(B.ROOT, "build", "extension-mainnet")
if os.path.exists(os.path.join(src, "manifest.json")):
    assets = dict(B.wallet(src))
    html = assets["assets/app.html"].decode()
    check("wallet: shim loads before app.js", html.index("android.js") < html.index("app.js"))
    check("wallet: no extension-only files", not any(n[7:] in B.SKIP for n in assets))
    check("wallet: phone page has a viewport tag", "name=\"viewport\"" in html)
    check("wallet: phone page is the popup layout", 'data-mode="popup"' in html and "assets/popup.html" not in assets)
    check("wallet: phone wording applied", "this browser" not in html and "this computer" not in html)
else:
    print("SKIP wallet assets: build/extension-mainnet is missing, run build_extension.py first")

print("ALL PASSED" if check.failed == 0 else f"FAILED {check.failed}")
sys.exit(1 if check.failed else 0)
