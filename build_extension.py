import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "extension")
WEB = os.path.join(ROOT, "web")
DIST = os.path.join(ROOT, "build", "extension")
LIB = ["compute.js", "engine.js", "mnemonic.js", "protocol.js", "sha256.js", "solana.js", "tokens.js", "vaultstore.js", "wordlist.js", "worker.js", "wots.js"]
ASSETS = ["logo.svg", "mark.svg"]
FILES = ["manifest.json", "popup.html", "popup.js", "popup.css", "app.html", "app.js", "ext.css", "feekey.js", "keep.js"]
ICONS = ["16.png", "32.png", "48.png", "128.png"]
WINDOWS = os.environ.get("OPEQ_EXT_COPY", "")


def build():
    shutil.rmtree(DIST, ignore_errors=True)
    os.makedirs(os.path.join(DIST, "icons"))
    for n in FILES:
        shutil.copy(os.path.join(SRC, n), DIST)
    for n in ICONS:
        shutil.copy(os.path.join(SRC, "icons", n), os.path.join(DIST, "icons"))
    extra = sorted(set(os.listdir(SRC)) - set(FILES) - {"icons"})
    if extra:
        raise SystemExit(f"unexpected files in extension/: {extra}")
    shutil.copy(os.path.join(WEB, "lab", "board", "app.css"), DIST)
    os.makedirs(os.path.join(DIST, "lib"))
    for n in LIB:
        shutil.copy(os.path.join(WEB, "lib", n), os.path.join(DIST, "lib"))
    os.makedirs(os.path.join(DIST, "assets"))
    for n in ASSETS:
        shutil.copy(os.path.join(WEB, "assets", n), os.path.join(DIST, "assets"))
    with open(os.path.join(DIST, "manifest.json")) as f:
        version = json.load(f)["version"]
    return version


def pack(version):
    out = os.path.join(ROOT, "build", f"opeq-extension-{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, names in os.walk(DIST):
            for n in sorted(names):
                full = os.path.join(base, n)
                z.write(full, os.path.relpath(full, DIST))
    return out


if __name__ == "__main__":
    version = build()
    print("built", DIST, "version", version)
    if "--windows" in sys.argv:
        if not WINDOWS:
            raise SystemExit("set OPEQ_EXT_COPY to the folder Chrome loads the unpacked extension from")
        shutil.rmtree(WINDOWS, ignore_errors=True)
        shutil.copytree(DIST, WINDOWS)
        print("copied to", WINDOWS)
    if "--zip" in sys.argv:
        print("packed", pack(version))
