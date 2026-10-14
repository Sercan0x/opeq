import struct

import protocol as P
import wots

SYSTEM = bytes(32)


class Reject(Exception):
    def __init__(self, code):
        super().__init__(P.ERRORS.get(code, str(code)))
        self.code = code


def process(program, accounts, data, slot):
    if len(accounts) > 64:
        raise Reject(2)
    if not data:
        raise Reject(1)
    tag = data[0]
    if tag == P.IX_INIT:
        return init(program, accounts, data)
    if tag == P.IX_EXEC:
        return execute(program, accounts, data, slot)
    if tag == P.IX_REKEY:
        return rekey(program, accounts, data, slot)
    raise Reject(1)


def need(accounts, n):
    if len(accounts) < n:
        raise Reject(17)


def init(program, accounts, data):
    if len(data) != P.INIT_LEN:
        raise Reject(1)
    need(accounts, 4)
    payer, state, wallet, system = accounts[:4]
    pub_seed, root = data[1:17], data[17:33]
    lamports, = struct.unpack_from("<Q", data, 33)
    aid = P.account_id(pub_seed, root)
    s, sbump = P.state_pda(aid, program)
    w, wbump = P.wallet_pda(aid, program)
    if state["key"] != s or wallet["key"] != w:
        raise Reject(15)
    if system["key"] != SYSTEM:
        raise Reject(20)
    if not payer.get("signer"):
        raise Reject(18)
    if state.get("data"):
        raise Reject(19)
    cpis = []
    if state.get("lamports", 0) < lamports:
        cpis.append(("transfer", lamports - state.get("lamports", 0)))
    cpis.append(("allocate", P.STATE_LEN))
    cpis.append(("assign", program))
    return cpis, P.pack_state(aid, pub_seed, root, 0, 0, sbump, wbump)


def load(program, accounts):
    need(accounts, 2)
    state, wallet = accounts[0], accounts[1]
    if state.get("owner") != program:
        raise Reject(3)
    if not state.get("writable"):
        raise Reject(14)
    data = bytes(state.get("data", b""))
    if len(data) < P.STATE_LEN or data[:8] != P.STATE_MAGIC:
        raise Reject(4)
    st = P.unpack_state(data)
    if state["key"] != P.state_pda(st["id"], program)[0] or wallet["key"] != P.wallet_pda(st["id"], program)[0]:
        raise Reject(5)
    return st


def check_leaf(st, leaf, expiry, slot, limit):
    if slot > expiry:
        raise Reject(6)
    if expiry > slot + P.MAX_EXPIRY_WINDOW:
        raise Reject(23)
    if leaf < st["next"]:
        raise Reject(7)
    if leaf >= limit:
        raise Reject(8)


def check_sig(st, leaf, digest, sig, path):
    if not wots.verify_blob(st["pub_seed"], st["root"], leaf, digest, sig, path):
        raise Reject(13)


def execute(program, accounts, data, slot):
    if len(data) < P.EXEC_FIXED:
        raise Reject(1)
    st = load(program, accounts)
    wallet = accounts[1]
    leaf, expiry = struct.unpack_from("<IQ", data, 1)
    check_leaf(st, leaf, expiry, slot, P.EXEC_LEAF_LIMIT)
    salt, = struct.unpack_from("<I", data, P.SALT_OFF)
    rnd = bytes(data[P.R_OFF:P.R_OFF + P.R_LEN])
    sig = data[P.SIG_OFF:P.PATH_OFF]
    path = data[P.PATH_OFF:P.TAIL_OFF]
    off = P.TAIL_OFF
    n = data[off]
    off += 1
    end = len(data)
    inner = []
    for _ in range(n):
        if off + 2 > end:
            raise Reject(12)
        pi, na = struct.unpack_from("<BB", data, off)
        if pi >= len(accounts):
            raise Reject(17)
        if na > 64:
            raise Reject(21)
        prog = accounts[pi]["key"]
        if prog == program:
            raise Reject(9)
        off += 2
        metas = []
        for _ in range(na):
            if off + 2 > end:
                raise Reject(12)
            ai, fl = struct.unpack_from("<BB", data, off)
            if ai >= len(accounts):
                raise Reject(17)
            if fl & ~3:
                raise Reject(10)
            acc = accounts[ai]
            signer = bool(fl & P.F_SIGNER)
            if signer and acc["key"] != wallet["key"] and not acc.get("signer"):
                raise Reject(11)
            metas.append((acc["key"], signer, bool(fl & P.F_WRITABLE)))
            off += 2
        if off + 2 > end:
            raise Reject(12)
        dl, = struct.unpack_from("<H", data, off)
        if off + 2 + dl > end:
            raise Reject(12)
        inner.append((prog, metas, bytes(data[off + 2:off + 2 + dl])))
        off += 2 + dl
    if off != end:
        raise Reject(12)
    check_sig(st, leaf, P.exec_digest(program, st["id"], st["epoch"], leaf, expiry, inner, salt, r=rnd), sig, path)
    new = bytearray(accounts[0]["data"])
    new[P.OFF_NEXT:P.OFF_NEXT + 4] = struct.pack("<I", leaf + 1)
    return inner, bytes(new)


def rekey(program, accounts, data, slot):
    if len(data) != P.REKEY_LEN:
        raise Reject(1)
    st = load(program, accounts)
    leaf, expiry = struct.unpack_from("<IQ", data, 1)
    check_leaf(st, leaf, expiry, slot, wots.LEAVES)
    salt, = struct.unpack_from("<I", data, P.SALT_OFF)
    rnd = bytes(data[P.R_OFF:P.R_OFF + P.R_LEN])
    sig = data[P.SIG_OFF:P.PATH_OFF]
    path = data[P.PATH_OFF:P.TAIL_OFF]
    off = P.TAIL_OFF
    new_pub_seed = data[off:off + wots.N]
    new_root = data[off + wots.N:off + 2 * wots.N]
    if new_root == st["root"]:
        raise Reject(22)
    check_sig(st, leaf, P.rekey_digest(program, st["id"], st["epoch"], leaf, expiry, new_pub_seed, new_root, salt, r=rnd), sig, path)
    new = bytearray(accounts[0]["data"])
    new[P.OFF_PUB_SEED:P.OFF_PUB_SEED + 16] = new_pub_seed
    new[P.OFF_ROOT:P.OFF_ROOT + 16] = new_root
    new[P.OFF_NEXT:P.OFF_EPOCH + 4] = struct.pack("<II", 0, st["epoch"] + 1)
    return [], bytes(new)
