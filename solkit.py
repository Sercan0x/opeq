import base64
import hashlib
import json
import os
import struct
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + body


def pk(s):
    b = b58decode(s)
    if len(b) != 32:
        raise ValueError(f"bad pubkey {s}")
    return b


def ps(b):
    return b58encode(b)


class Keypair:
    def __init__(self, seed):
        self.seed = seed
        self.sk = Ed25519PrivateKey.from_private_bytes(seed)
        self.pub = self.sk.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )

    @staticmethod
    def generate():
        return Keypair(os.urandom(32))

    def sign(self, msg):
        return self.sk.sign(msg)

    def save(self, path):
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(list(self.seed + self.pub)))


def load_keypair(path):
    raw = open(os.path.expanduser(path)).read().strip()
    b = bytes(json.loads(raw)) if raw.startswith("[") else b58decode(raw)
    if len(b) == 64:
        kp = Keypair(b[:32])
        if kp.pub != b[32:]:
            raise ValueError("key file: public half does not match secret")
        return kp
    if len(b) == 32:
        return Keypair(b)
    raise ValueError("key file must hold 64 bytes (json array or base58)")


P = 2**255 - 19
D = (-121665 * pow(121666, P - 2, P)) % P


def on_curve(b):
    y = (int.from_bytes(b, "little") & ((1 << 255) - 1)) % P
    y2 = y * y % P
    u = (y2 - 1) % P
    v = (D * y2 + 1) % P
    if v == 0:
        return False
    x2 = u * pow(v, P - 2, P) % P
    return x2 == 0 or pow(x2, (P - 1) // 2, P) == 1


def find_pda_bump(seeds, program):
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + program + b"ProgramDerivedAddress").digest()
        if not on_curve(h):
            return h, bump
    raise ValueError("no pda")


def find_pda(seeds, program):
    return find_pda_bump(seeds, program)[0]


def compact(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def u8(v):
    return struct.pack("<B", v)


def u16(v):
    return struct.pack("<H", v)


def u32(v):
    return struct.pack("<I", v)


def u64(v):
    return struct.pack("<Q", v)


def borsh_str(s):
    b = s.encode()
    return u32(len(b)) + b


def anchor_disc(name):
    return hashlib.sha256(f"global:{name}".encode()).digest()[:8]


def compile_message(payer, ixs, blockhash):
    metas = {payer: [True, True]}
    order = [payer]
    for prog, accs, _ in ixs:
        for k, s, w in accs:
            if k in metas:
                metas[k][0] |= s
                metas[k][1] |= w
            else:
                metas[k] = [s, w]
                order.append(k)
        if prog not in metas:
            metas[prog] = [False, False]
            order.append(prog)
    keys = sorted(order, key=lambda k: (k != payer, not metas[k][0], not metas[k][1]))
    nsig = sum(1 for k in keys if metas[k][0])
    ro_signed = sum(1 for k in keys if metas[k][0] and not metas[k][1])
    ro_unsigned = sum(1 for k in keys if not metas[k][0] and not metas[k][1])
    idx = {k: i for i, k in enumerate(keys)}
    out = bytearray([nsig, ro_signed, ro_unsigned])
    out += compact(len(keys)) + b"".join(keys) + blockhash + compact(len(ixs))
    for prog, accs, data in ixs:
        out += bytes([idx[prog]]) + compact(len(accs)) + bytes(idx[a[0]] for a in accs)
        out += compact(len(data)) + data
    return bytes(out), keys[:nsig]


COMPUTE_BUDGET = pk("ComputeBudget111111111111111111111111111111")


class RpcError(Exception):
    pass


class Rpc:
    def __init__(self, url, priority=0):
        self.url = url
        self.priority = priority

    def call(self, method, params=None):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
        req = urllib.request.Request(self.url, body, {"content-type": "application/json"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    res = json.load(r)
                break
            except urllib.error.HTTPError as e:
                if e.code in (429, 502, 503) and attempt < 4:
                    time.sleep(2 + attempt * 2)
                    continue
                raise
        if "error" in res:
            raise RpcError(res["error"])
        return res["result"]

    def account(self, key):
        v = self.call("getAccountInfo", [ps(key), {"encoding": "base64", "commitment": "confirmed"}])["value"]
        if v is None:
            return None
        return {"owner": pk(v["owner"]), "lamports": v["lamports"], "data": base64.b64decode(v["data"][0])}

    def balance(self, key):
        return self.call("getBalance", [ps(key), {"commitment": "confirmed"}])["value"]

    def rent(self, size):
        return self.call("getMinimumBalanceForRentExemption", [size])

    def program_accounts(self, program, filters):
        res = self.call("getProgramAccounts", [ps(program), {"encoding": "base64", "commitment": "confirmed", "filters": filters}])
        return [(pk(a["pubkey"]), base64.b64decode(a["account"]["data"][0])) for a in res]

    def send(self, ixs, signers, cu_limit=200_000):
        pre = [(COMPUTE_BUDGET, [], u8(2) + u32(cu_limit))]
        if self.priority:
            pre.append((COMPUTE_BUDGET, [], u8(3) + u64(self.priority)))
        ixs = pre + list(ixs)
        bh = self.call("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]
        payer = signers[0].pub
        msg, signer_keys = compile_message(payer, ixs, b58decode(bh["blockhash"]))
        by_pub = {s.pub: s for s in signers}
        missing = [ps(k) for k in signer_keys if k not in by_pub]
        if missing:
            raise ValueError(f"missing signers: {missing}")
        tx = compact(len(signer_keys)) + b"".join(by_pub[k].sign(msg) for k in signer_keys) + msg
        if len(tx) > 1232:
            raise ValueError(f"transaction too large: {len(tx)} bytes")
        raw = base64.b64encode(tx).decode()
        try:
            sig = self.call("sendTransaction", [raw, {"encoding": "base64", "preflightCommitment": "confirmed"}])
        except RpcError as e:
            err = e.args[0]
            logs = (err.get("data") or {}).get("logs") or []
            raise RpcError(err.get("message", str(err)) + "\n" + "\n".join(logs)) from None
        deadline = time.time() + 90
        last_resend = time.time()
        while time.time() < deadline:
            st = self.call("getSignatureStatuses", [[sig]])["value"][0]
            if st:
                if st.get("err"):
                    raise RpcError(f"tx {sig} failed: {st['err']}")
                if st.get("confirmationStatus") in ("confirmed", "finalized"):
                    return sig
            if time.time() - last_resend > 4:
                try:
                    self.call("sendTransaction", [raw, {"encoding": "base64", "skipPreflight": True}])
                except RpcError:
                    pass
                last_resend = time.time()
            time.sleep(1.5)
        raise RpcError(f"tx {sig} not confirmed in 90s, check explorer before retrying")
