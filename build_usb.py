import argparse
import hashlib
import json
import os
import shutil
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = "1.1.0"
CHECKS = os.path.join(ROOT, "web", "usb")
USB = os.path.join(ROOT, "usb")
SRC = os.path.join(ROOT, "build", "extension-mainnet")
SKIP = {"manifest.json", "bg.js", "popup.html", "popup.js", "popup.css", "keep.js"}
ADDED = ["gate.js", "usbstore.js", "usb.css", "keep.js", "opeq.ps1", "activate.js"]
MODULE_TAG = '<script type="module" src="app.js"></script>'

REWORD = {
    "app.js": [
        ("const store = new IdbStore();", "const store = globalThis.OPEQ_USB.store;", 1),
        ("chrome.storage.local.", "OPEQ_USB.local.", None),
        ("localStorage.", "OPEQ_USB.ls.", None),
        ("const IDLE_MS = 10 * 60 * 1000, HIDDEN_MS = 5 * 60 * 1000;", "const IDLE_MS = 3 * 60 * 1000, HIDDEN_MS = 2 * 60 * 1000;", 1),
        ("Locked after 10 minutes without activity.", "Locked after 3 minutes without activity.", None),
        ("in the background for more than 5 minutes.", "in the background for more than 2 minutes.", 1),
        ("that RPC could not be reached from the extension", "that RPC could not be reached from OPEQ", 1),
    ],
    "app.html": [
        (MODULE_TAG, '<link rel="stylesheet" href="usb.css">\n<script src="shim.js"></script>\n<script type="module" src="gate.js"></script>', 1),
        ("connect-src https:;", "connect-src 'self' https:;", 1),
        ("<title>OPEQ Wallet</title>", "<title>OPEQ Wallet USB</title>", 1),
        ("wallets in this browser", "wallets on this USB", None),
        ("Your keys are made in this browser and never leave it.", "Your keys are made on this computer and kept only on your USB.", 1),
        ("New password for this browser", "New password for this USB", 1),
        ("Remove from this browser", "Remove from this USB", 1),
        ('autocomplete="new-password"', 'autocomplete="off"', 4),
        ('autocomplete="current-password"', 'autocomplete="off"', 2),
        ('<p class="hint">One-time setup. Send at least 0.01 SOL to this activation address from any wallet. About 0.0015 SOL goes to rent, 0.005 SOL stays on the fee key and the rest moves into your opeq wallet.</p>',
         '<ol class="steps act-steps"><li>Copy the activation address below.</li><li>From Phantom, an exchange or any other Solana wallet, send at least 0.01 SOL to that address. You do this once.</li><li>When the SOL arrives, OPEQ shows it here. Then press Activate.</li></ol>\n        <p class="hint">About 0.0015 SOL pays for the setup, 0.005 SOL stays on the fee key that pays network fees, and the rest moves into your OPEQ wallet.</p>', 1),
        ('<p class="hint" id="i-bal"></p>', '<p class="hint" id="i-bal"></p>\n        <p class="act-wait" id="i-wait" role="status"></p>', 1),
    ],
    "lib/engine.js": [
        ("""      if (err.expired) {
        await this._clearIf(leaf);""", """      if (err.expired) {
        if (burnOnFail) await this.burnIfLive(leaf);
        await this._clearIf(leaf);""", 1),
        ("""    delete r.inflight;
    await this.put(r);
    return { state: "expired",""", """    await this.burnIfLive(leaf);
    const after = await this.load();
    delete after.inflight;
    await this.put(after);
    return { state: "expired",""", 1),
    ],
    "lib/vaultstore.js": [("const PBKDF2_ITER = 600000;", "const PBKDF2_ITER = 2000000;", 1)],
    "evm.js": [
        ('const store = new IdbStore("opeq-evm");', "const store = globalThis.OPEQ_USB.store;", 1),
        ("chrome.storage.local.", "OPEQ_USB.local.", None),
        ("localStorage.", "OPEQ_USB.ls.", None),
    ],
}


def reword(name, text):
    for old, new, want in REWORD.get(name, []):
        n = text.count(old)
        if n == 0 or (want is not None and n != want):
            raise SystemExit(f"{name}: expected {want or 'some'} '{old}', found {n}")
        text = text.replace(old, new)
    return text


def build(src, out):
    if not os.path.exists(os.path.join(src, "manifest.json")):
        raise SystemExit(f"{src} is not a built extension; run build_extension.py first")
    if os.path.exists(out):
        shutil.rmtree(out)
    app = os.path.join(out, "app")
    shutil.copytree(src, app, ignore=lambda d, names: [n for n in names if d == src and n in SKIP])
    for name in ADDED:
        shutil.copy(os.path.join(USB, name), os.path.join(app, name))
    shutil.copy(os.path.join(USB, "shim.js"), os.path.join(app, "shim.js"))
    for name in REWORD:
        p = os.path.join(app, name)
        with open(p, encoding="utf-8") as f:
            text = reword(name, f.read())
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    with open(os.path.join(app, "app.js"), encoding="utf-8") as f:
        code = f.read()
    with open(os.path.join(app, "evm.js"), encoding="utf-8") as f:
        evm = f.read()
    for left in ("chrome.storage.local", "localStorage", "new IdbStore("):
        if left in code or left in evm:
            raise SystemExit(f"app.js or evm.js still uses {left}")
    with open(os.path.join(app, "opeq.ps1"), encoding="utf-8") as f:
        ps = f.read()
    with open(os.path.join(app, "opeq.ps1"), "w", encoding="utf-8-sig", newline="\r\n") as f:
        f.write(ps)
    with open(os.path.join(app, "VERSION"), "w", newline="\n") as f:
        f.write(VERSION + "\n")
    os.makedirs(os.path.join(out, "data"))
    shutil.copy(os.path.join(USB, "README.txt"), os.path.join(out, "README.txt"))
    with open(os.path.join(USB, "OPEQ.cmd"), encoding="utf-8") as f:
        cmd = f.read().replace("\r\n", "\n")
    with open(os.path.join(out, "OPEQ.cmd"), "w", encoding="ascii", newline="\r\n") as f:
        f.write(cmd)


def files_of(out):
    found = []
    for d, dirs, names in os.walk(out):
        dirs.sort()
        for n in sorted(names):
            p = os.path.join(d, n)
            rel = os.path.relpath(p, out).replace(os.sep, "/")
            if not rel.startswith("data/"):
                found.append((rel, p))
    return found


def checklist(out):
    files = {}
    for rel, p in files_of(out):
        with open(p, "rb") as f:
            files[rel] = hashlib.sha256(f.read()).hexdigest()
    os.makedirs(CHECKS, exist_ok=True)
    path = os.path.join(CHECKS, VERSION + ".json")
    with open(path, "w", newline="\n") as f:
        json.dump({"version": VERSION, "files": files}, f, indent=1, sort_keys=True)
        f.write("\n")
    return path


def entry(name, is_dir=False):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = ((0o40755 << 16) | 0x10) if is_dir else (0o100644 << 16)
    info.compress_type = zipfile.ZIP_STORED if is_dir else zipfile.ZIP_DEFLATED
    return info


def pack(out, zpath):
    base = os.path.basename(out.rstrip("/"))
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr(entry(base + "/data/", True), b"")
        for rel, p in files_of(out):
            with open(p, "rb") as f:
                z.writestr(entry(base + "/" + rel), f.read())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--src", default=SRC)
    p.add_argument("--out", default=os.path.join(ROOT, "build", "OPEQ-USB"))
    p.add_argument("--zip", action="store_true")
    a = p.parse_args()
    build(a.src, a.out)
    print(f"built {a.out}, code check list {checklist(a.out)}")
    if a.zip:
        zpath = a.out.rstrip("/") + ".zip"
        pack(a.out, zpath)
        print(f"zip {zpath}, sha256 {hashlib.sha256(open(zpath, 'rb').read()).hexdigest()}")


if __name__ == "__main__":
    main()
