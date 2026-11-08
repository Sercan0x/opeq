import argparse
import gzip
import io
import json
import os
import re
import sys
import tarfile

ROOT = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(ROOT, "web", "lib")
SDK = os.path.join(ROOT, "sdk")
SRC = os.path.join(SDK, "src")
ENTRIES = ["engine.js", "compute.js", "evmwallet.js", "wots.js", "evmwots.js", "mnemonic.js", "protocol.js",
           "solana.js", "vaultstore.js", "sha256.js", "keccak.js", "secp256k1.js", "evmtx.js", "evmcode.js"]
EXTRA = {"feekey.js": os.path.join(ROOT, "extension", "feekey.js")}
PACK_FILES = ["package.json", "README.md", "index.js", "filestore.js", "locks.js"]
SAFE = re.compile(r"^(src/feekey\.js|src/lib/[a-z0-9]+\.js|examples/[a-z0-9-]+\.mjs)$")
IMPORT = re.compile(r'from\s+"\./([A-Za-z0-9_]+\.js)"')
EPOCH = 1767225600


def closure():
    seen, todo = set(), list(ENTRIES)
    while todo:
        f = todo.pop()
        if f in seen:
            continue
        seen.add(f)
        with open(os.path.join(LIB, f), encoding="utf-8") as h:
            todo += IMPORT.findall(h.read())
    return sorted(seen)


def wanted():
    out = {os.path.join("lib", f): os.path.join(LIB, f) for f in closure()}
    for name, path in EXTRA.items():
        out[name] = path
    return out


def read(p):
    with open(p, "rb") as h:
        return h.read()


def sync(check):
    want = wanted()
    bad = []
    for rel, src in want.items():
        dst = os.path.join(SRC, rel)
        data = read(src)
        if os.path.exists(dst) and read(dst) == data:
            continue
        bad.append(rel)
        if not check:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "wb") as h:
                h.write(data)
    extra = []
    for d, _, files in os.walk(SRC):
        for f in files:
            rel = os.path.relpath(os.path.join(d, f), SRC)
            if rel not in want:
                extra.append(rel)
                if not check:
                    os.remove(os.path.join(d, f))
    return bad, extra, len(want)


def pack_list():
    files = [(f, os.path.join(SDK, f)) for f in PACK_FILES]
    files.append(("LICENSE", os.path.join(ROOT, "LICENSE")))
    for d in ("src", "examples"):
        for base, _, names in os.walk(os.path.join(SDK, d)):
            for n in names:
                p = os.path.join(base, n)
                rel = os.path.relpath(p, SDK).replace(os.sep, "/")
                if not SAFE.match(rel):
                    raise SystemExit(f"refusing to pack {rel}: only library .js files and example .mjs files may ship")
                files.append((rel, p))
    return sorted(files)


def pack(out):
    with open(os.path.join(SDK, "package.json"), encoding="utf-8") as h:
        version = json.load(h)["version"]
    out = out or os.path.join(ROOT, "build", f"opeq-sdk-{version}.tgz")
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for rel, path in pack_list():
            data = read(path)
            info = tarfile.TarInfo("package/" + rel)
            info.size, info.mtime, info.mode = len(data), EPOCH, 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            t.addfile(info, io.BytesIO(data))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as h:
        with gzip.GzipFile(fileobj=h, mode="wb", mtime=EPOCH, filename="") as g:
            g.write(raw.getvalue())
    return out


def main():
    ap = argparse.ArgumentParser(description="build the OPEQ SDK from the wallet's own library files")
    ap.add_argument("--check", action="store_true", help="fail if sdk/src differs from web/lib, change nothing")
    ap.add_argument("--pack", action="store_true", help="also write an npm-style .tgz to build/")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    bad, extra, n = sync(a.check)
    if a.check:
        if bad or extra:
            print("sdk/src is out of date:", ", ".join(bad + extra))
            sys.exit(1)
        print(f"sdk/src matches the wallet library ({n} files)")
        return
    print(f"sdk/src synced: {n} files, {len(bad)} updated, {len(extra)} removed")
    if a.pack:
        print("packed", pack(a.out))


if __name__ == "__main__":
    main()
