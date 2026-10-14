import hashlib
import struct

import wots
from solkit import find_pda_bump

IX_INIT = 0
IX_EXEC = 1
IX_REKEY = 2

STATE_MAGIC = b"OPEQST01"
STATE_LEN = 88
OFF_ID = 8
OFF_PUB_SEED = 40
OFF_ROOT = 56
OFF_NEXT = 72
OFF_EPOCH = 76
OFF_SBUMP = 80
OFF_WBUMP = 81

F_SIGNER = 1
F_WRITABLE = 2

FORMAT = 1
R_LEN = 16
REKEY_RESERVE = 16
EXEC_LEAF_LIMIT = wots.LEAVES - REKEY_RESERVE
GRIND_TRIES = 1 << 17

LAYOUTS = {
    1: {"salt": 13, "r": 17, "sig": 33, "tag_exec": b"opeq/exec/v1", "tag_rekey": b"opeq/rekey/v1"},
}

SALT_OFF = LAYOUTS[FORMAT]["salt"]
R_OFF = LAYOUTS[FORMAT]["r"]
SIG_OFF = LAYOUTS[FORMAT]["sig"]
PATH_OFF = SIG_OFF + wots.SIG_LEN
TAIL_OFF = PATH_OFF + wots.PATH_LEN
EXEC_FIXED = TAIL_OFF + 1
REKEY_LEN = TAIL_OFF + 2 * wots.N
INIT_LEN = 1 + 2 * wots.N + 8
TAG_EXEC = LAYOUTS[FORMAT]["tag_exec"]
TAG_REKEY = LAYOUTS[FORMAT]["tag_rekey"]

MAX_EXPIRY_WINDOW = 300

ERRORS = {
    1: "bad instruction", 2: "too many accounts", 3: "state not owned by program", 4: "bad state account",
    5: "wallet/state address mismatch", 6: "signature expired", 7: "leaf already used", 8: "leaf out of range",
    9: "self cpi", 10: "bad meta flags", 11: "signer escalation", 12: "malformed inner instructions",
    13: "bad signature", 14: "state not writable", 15: "init address mismatch", 16: "too many slices",
    17: "account index out of range", 18: "payer must sign", 19: "already initialized", 20: "bad system program",
    21: "too many metas", 22: "rekey to the current root", 23: "expiry too far in the future",
}


def account_id(pub_seed, root):
    return hashlib.sha256(b"opeq/id/v1" + pub_seed + root).digest()


def state_pda(aid, program):
    return find_pda_bump([b"s", aid], program)


def wallet_pda(aid, program):
    return find_pda_bump([b"w", aid], program)


def _start(fmt, r):
    h = hashlib.sha256()
    if LAYOUTS[fmt]["r"] is not None:
        if len(r) != R_LEN:
            raise ValueError("a 16 byte randomizer is required")
        h.update(r)
    return h


def exec_hasher(program, aid, epoch, leaf, expiry, inner, fmt=FORMAT, r=b""):
    h = _start(fmt, r)
    h.update(LAYOUTS[fmt]["tag_exec"])
    h.update(program + aid + struct.pack("<IIQ", epoch, leaf, expiry))
    h.update(struct.pack("<B", len(inner)))
    for prog, metas, data in inner:
        h.update(prog + struct.pack("<B", len(metas)))
        for key, signer, writable in metas:
            h.update(key + struct.pack("<B", (F_SIGNER if signer else 0) | (F_WRITABLE if writable else 0)))
        h.update(struct.pack("<H", len(data)) + data)
    return h


def rekey_hasher(program, aid, epoch, leaf, expiry, new_pub_seed, new_root, fmt=FORMAT, r=b""):
    h = _start(fmt, r)
    h.update(LAYOUTS[fmt]["tag_rekey"] + program + aid + struct.pack("<IIQ", epoch, leaf, expiry) + new_pub_seed + new_root)
    return h


def salted(hasher, salt, fmt=FORMAT):
    h = hasher.copy()
    if LAYOUTS[fmt]["salt"] is not None:
        h.update(struct.pack("<I", salt))
    return h.digest()[:wots.N]


def exec_digest(program, aid, epoch, leaf, expiry, inner, salt, fmt=FORMAT, r=b""):
    return salted(exec_hasher(program, aid, epoch, leaf, expiry, inner, fmt, r), salt, fmt)


def rekey_digest(program, aid, epoch, leaf, expiry, new_pub_seed, new_root, salt, fmt=FORMAT, r=b""):
    return salted(rekey_hasher(program, aid, epoch, leaf, expiry, new_pub_seed, new_root, fmt, r), salt, fmt)


def verify_cost(digest16):
    return sum(wots.W - 1 - d for d in wots.digits(digest16))


def grind(hasher, tries=GRIND_TRIES, fmt=FORMAT):
    if LAYOUTS[fmt]["salt"] is None:
        d = hasher.digest()[:wots.N]
        return 0, d, verify_cost(d)
    best = None
    for salt in range(tries):
        h = hasher.copy()
        h.update(struct.pack("<I", salt))
        d = h.digest()[:wots.N]
        c = verify_cost(d)
        if best is None or c < best[2]:
            best = (salt, d, c)
    return best


def pack_state(aid, pub_seed, root, nxt, epoch, sbump, wbump):
    return STATE_MAGIC + aid + pub_seed + root + struct.pack("<IIBB", nxt, epoch, sbump, wbump) + bytes(6)


def unpack_state(data):
    if len(data) < STATE_LEN or data[:8] != STATE_MAGIC:
        raise ValueError("not a opeq state account")
    nxt, epoch, sbump, wbump = struct.unpack_from("<IIBB", data, OFF_NEXT)
    return {"id": bytes(data[8:40]), "pub_seed": bytes(data[40:56]), "root": bytes(data[56:72]),
            "next": nxt, "epoch": epoch, "sbump": sbump, "wbump": wbump}


def _header(tag, leaf, expiry, salt, r, fmt):
    lay = LAYOUTS[fmt]
    out = struct.pack("<BIQ", tag, leaf, expiry)
    if lay["salt"] is not None:
        out += struct.pack("<I", salt)
    if lay["r"] is not None:
        out += r
    return out


def build_exec(leaf, expiry, salt, r, sig, path, inner, outer_keys, fmt=FORMAT):
    pos = {k: i for i, k in enumerate(outer_keys)}
    body = bytearray(_header(IX_EXEC, leaf, expiry, salt, r, fmt) + sig + path + struct.pack("<B", len(inner)))
    for prog, metas, data in inner:
        body += struct.pack("<BB", pos[prog], len(metas))
        for key, signer, writable in metas:
            body += struct.pack("<BB", pos[key], (F_SIGNER if signer else 0) | (F_WRITABLE if writable else 0))
        body += struct.pack("<H", len(data)) + data
    return bytes(body)


def build_init(pub_seed, root, lamports):
    return struct.pack("<B", IX_INIT) + pub_seed + root + struct.pack("<Q", lamports)


def build_rekey(leaf, expiry, salt, r, sig, path, new_pub_seed, new_root, fmt=FORMAT):
    return _header(IX_REKEY, leaf, expiry, salt, r, fmt) + sig + path + new_pub_seed + new_root
