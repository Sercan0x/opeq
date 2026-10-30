import argparse
import hashlib
import json
import os
import re
import shutil
import urllib.request
import zipfile
from urllib.parse import urlparse

import program

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "extension")
WEB = os.path.join(ROOT, "web")
LIB = ["amms.js", "jupiter.js", "compute.js", "engine.js", "mnemonic.js", "protocol.js", "sha256.js", "solana.js", "tokens.js", "vaultstore.js", "wordlist.js", "worker.js", "wots.js",
       "evmcode.js", "evmtx.js", "evmwallet.js", "evmwots.js", "keccak.js", "secp256k1.js"]
ASSETS = ["logo.svg", "mark.svg"]
FILES = ["manifest.json", "popup.html", "popup.js", "popup.css", "app.html", "app.js", "ext.css", "evm.js", "feekey.js", "keep.js", "net.js", "bg.js"]
EVM_TESTNETS = [{"chainId": 84532, "name": "Base Sepolia", "symbol": "ETH", "rpc": "https://sepolia.base.org", "explorer": "https://sepolia.basescan.org"}]
ICONS = ["16.png", "32.png", "48.png", "128.png"]
LEGACY_PROGRAM = "424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN"
DEVNET_RPC = "https://api.devnet.solana.com"
B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
TAG = re.compile(r'<(title|p|span|li|a)((?:\s[^<>]*?)?)\sdata-only="(devnet|mainnet)"([^<>]*)>(.*?)</\1>', re.S)
HOST = re.compile(r"^[a-z0-9.-]+(:[0-9]{1,5})?$")
MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
DEVNET_PROGRAMS = {LEGACY_PROGRAM, "B8h654SDQbXEg5r3Bjbcpd6LYh74orB4yqifh6yQF4vp", "2VXWnTUp", "9MPeZzh3rdpJA88AtZ26j5yrDwcsdzWCzJ4jWoEQhBnG", "HKgkPK5DgB7tMMaVg1wExZ6M5p9nJ7kL275cb1BddxXj", "9Ce67NYP"}
LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
CHECK = {}
DENY = ["api.devnet.solana.com", "cluster=devnet", "faucet.solana.com", "Free devnet SOL", "devnet only", LEGACY_PROGRAM]


def config(args):
    if args.net == "devnet":
        return {"name": "devnet", "mainnet": False, "program": args.program or LEGACY_PROGRAM, "rpc": args.rpc or DEVNET_RPC, "genesis": DEVNET_GENESIS,
                "explorerQuery": "?cluster=devnet", "sol": "devnet SOL", "swap": True, "jupiter": False, "evm": EVM_TESTNETS}
    if not args.program or not B58.match(args.program):
        raise SystemExit("a mainnet build needs --program <mainnet program id>")
    if any(args.program == p or args.program.startswith(p) for p in DEVNET_PROGRAMS):
        raise SystemExit("a devnet or test program id must never be used on mainnet")
    u = urlparse(args.rpc or "")
    if u.scheme != "https" or u.username or u.password or not HOST.match(u.netloc or "") or any(x in u.netloc for x in ("devnet", "testnet")):
        raise SystemExit("a mainnet build needs --rpc https://<mainnet rpc host>/... without credentials in the host part")
    for k in ("authority", "gov", "admin_state"):
        v = getattr(args, k)
        if not v or not B58.match(v):
            raise SystemExit(f"a mainnet build needs --{k.replace('_', '-')} <address>")
        CHECK[k] = v
    if args.skip_chain_check:
        raise SystemExit("--skip-chain-check is not allowed for a mainnet build")
    if (u.query or "key" in u.path.lower() or re.search(r"[A-Za-z0-9_-]{16,}", u.path)) and not args.allow_rpc_key:
        raise SystemExit("the --rpc url carries a key that every user can read from the extension; use a proxy or pass --allow-rpc-key")
    if not args.version or not re.match(r"^\d+\.\d+\.\d+$", args.version):
        raise SystemExit("a mainnet build needs an explicit --version like 1.0.0")
    return {"name": "mainnet", "mainnet": True, "program": args.program, "rpc": args.rpc, "genesis": MAINNET_GENESIS,
            "explorerQuery": "", "sol": "SOL", "swap": False, "jupiter": True, "evm": []}


def strip_other(html, net):
    expected = html.count("data-only=")
    seen = 0
    def keep(m):
        nonlocal seen
        seen += 1
        if re.search(rf"<{m.group(1)}[\s>]", m.group(5)) or "data-only=" in m.group(5):
            raise SystemExit(f"nested <{m.group(1)}> inside a data-only element, refusing to guess")
        if m.group(3) != net:
            return ""
        return f"<{m.group(1)}{m.group(2)}{m.group(4)}>{m.group(5)}</{m.group(1)}>"
    out = TAG.sub(keep, html)
    if seen != expected or "data-only=" in out:
        raise SystemExit("a data-only element was not handled")
    return out


def rpc_call(url, method, params):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), headers={"Content-Type": "application/json", "User-Agent": "opeq-build/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    if "error" in out:
        raise SystemExit(f"rpc {method} failed: {out['error']}")
    return out["result"]


def check_mainnet(cfg):
    if rpc_call(cfg["rpc"], "getGenesisHash", []) != MAINNET_GENESIS:
        raise SystemExit("the --rpc endpoint is not Solana mainnet")
    acc = rpc_call(cfg["rpc"], "getAccountInfo", [cfg["program"], {"encoding": "jsonParsed"}])["value"]
    if not acc or acc["owner"] != LOADER or not acc["executable"]:
        raise SystemExit("the --program account is not a deployed upgradeable program on mainnet")
    pd = acc["data"]["parsed"]["info"]["programData"]
    import base64
    raw = base64.b64decode(rpc_call(cfg["rpc"], "getAccountInfo", [pd, {"encoding": "base64"}])["value"]["data"][0])
    elf = program.build().elf()
    code = raw[45:]
    if code[:len(elf)] != elf or any(code[len(elf):]):
        raise SystemExit("on-chain program code differs from the program built from program.py")
    auth = raw[13:45] if raw[12] == 1 else None
    if not auth or b58(auth) != CHECK["authority"]:
        raise SystemExit(f"program upgrade authority is {auth and b58(auth)}, expected {CHECK["authority"]}")
    gov = rpc_call(cfg["rpc"], "getAccountInfo", [CHECK["gov"], {"encoding": "jsonParsed"}])["value"]
    if not gov or gov["owner"] != LOADER or not gov["executable"]:
        raise SystemExit("the --gov account is not a deployed program on mainnet")
    graw = base64.b64decode(rpc_call(cfg["rpc"], "getAccountInfo", [gov["data"]["parsed"]["info"]["programData"], {"encoding": "base64"}])["value"]["data"][0])
    if graw[12] != 0:
        raise SystemExit("the gov program still has an upgrade authority, it must be immutable")
    gcode = graw[45:]
    if gcode[:len(elf)] != elf or any(gcode[len(elf):]):
        raise SystemExit("the gov program does not run the same code as the program built from program.py")
    import sys
    sys.path.insert(0, ROOT)
    import protocol as P
    from solkit import pk
    st = rpc_call(cfg["rpc"], "getAccountInfo", [CHECK["admin_state"], {"encoding": "base64"}])["value"]
    if not st or st["owner"] != CHECK["gov"]:
        raise SystemExit("the --admin-state account is not an opeq state account on the gov program")
    aid = P.unpack_state(base64.b64decode(st["data"][0]))["id"]
    if P.state_pda(aid, pk(CHECK["gov"]))[0] != pk(CHECK["admin_state"]) or b58(P.wallet_pda(aid, pk(CHECK["gov"]))[0]) != CHECK["authority"]:
        raise SystemExit("--authority is not the wallet of the admin vault on --gov")
    print("mainnet check ok: genesis, executable program, code sha256", hashlib.sha256(elf).hexdigest()[:16], "upgrade authority", b58(auth), "gov immutable")


def b58(b):
    a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = a[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def build(args):
    cfg = config(args)
    if cfg["mainnet"]:
        check_mainnet(cfg)
    final = os.path.join(ROOT, "build", "extension" if cfg["name"] == "devnet" else "extension-mainnet")
    dist = final + ".tmp"
    shutil.rmtree(dist, ignore_errors=True)
    os.makedirs(os.path.join(dist, "icons"))
    extra = sorted(set(os.listdir(SRC)) - set(FILES) - {"icons"})
    if extra:
        raise SystemExit(f"unexpected files in extension/: {extra}")
    for n in FILES:
        with open(os.path.join(SRC, n), encoding="utf-8") as f:
            text = f.read()
        if n.endswith(".html"):
            text = strip_other(text, cfg["name"])
        if n == "net.js":
            text = "export const NET = " + json.dumps(cfg, indent=2) + ";\n"
        if n == "manifest.json":
            m = json.loads(text)
            if cfg["mainnet"]:
                m["name"] = "OPEQ Wallet"
                m["action"]["default_title"] = "OPEQ Wallet"
                m["description"] = "A Solana wallet built to resist quantum computers. Hash-based one-time signatures, verified on chain. Beta."
                if args.version:
                    m["version"] = args.version
            text = json.dumps(m, indent=2) + "\n"
        with open(os.path.join(dist, n), "w", encoding="utf-8") as f:
            f.write(text)
    for n in ICONS:
        shutil.copy(os.path.join(SRC, "icons", n), os.path.join(dist, "icons"))
    shutil.copy(os.path.join(WEB, "lab", "board", "app.css"), dist)
    os.makedirs(os.path.join(dist, "lib"))
    for n in LIB:
        shutil.copy(os.path.join(WEB, "lib", n), os.path.join(dist, "lib"))
    os.makedirs(os.path.join(dist, "assets"))
    for n in ASSETS:
        shutil.copy(os.path.join(WEB, "assets", n), os.path.join(dist, "assets"))
    for base, _, names in os.walk(dist):
        for n in names:
            if n.endswith((".js", ".html", ".css", ".json")):
                with open(os.path.join(base, n), encoding="utf-8") as f:
                    body = f.read()
                if cfg["mainnet"] and n != "mnemonic.js":
                    hit = [d for d in DENY if d in body]
                    if hit:
                        raise SystemExit(f"devnet leftovers {hit} in mainnet build: {n}")
    if cfg["mainnet"]:
        for n in ("popup.html", "app.html"):
            with open(os.path.join(dist, n), encoding="utf-8") as f:
                if "beta, start with small amounts" not in f.read():
                    raise SystemExit(f"mainnet banner missing in {n}")
    with open(os.path.join(dist, "manifest.json")) as f:
        version = json.load(f)["version"]
    shutil.rmtree(final, ignore_errors=True)
    os.rename(dist, final)
    return final, cfg, version


def pack(dist, cfg, version):
    out = os.path.join(ROOT, "build", f"opeq-extension-{cfg['name']}-{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, names in os.walk(dist):
            for n in sorted(names):
                full = os.path.join(base, n)
                z.write(full, os.path.relpath(full, dist))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--net", choices=["devnet", "mainnet"], default="devnet")
    ap.add_argument("--program")
    ap.add_argument("--rpc")
    ap.add_argument("--version")
    ap.add_argument("--windows", action="store_true")
    ap.add_argument("--zip", action="store_true")
    ap.add_argument("--skip-chain-check", action="store_true")
    ap.add_argument("--authority")
    ap.add_argument("--gov")
    ap.add_argument("--admin-state")
    ap.add_argument("--allow-rpc-key", action="store_true")
    args = ap.parse_args()
    dist, cfg, version = build(args)
    print("built", dist, cfg["name"], "version", version, "program", cfg["program"])
    if args.windows:
        target = os.environ.get("OPEQ_EXT_COPY", "")
        if not target:
            raise SystemExit("set OPEQ_EXT_COPY to the folder Chrome loads the unpacked extension from")
        if cfg["mainnet"]:
            target = target.rstrip("/") + "-mainnet"
        shutil.rmtree(target, ignore_errors=True)
        shutil.copytree(dist, target)
        print("copied to", target)
    if args.zip:
        print("packed", pack(dist, cfg, version))
