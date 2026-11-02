import hashlib
import struct

import msig_protocol as M

SYSTEM = bytes(32)


class Reject(Exception):
    def __init__(self, code):
        super().__init__(M.ERRORS.get(code, str(code)))
        self.code = code


def pda(seeds, program):
    try:
        return M.create_program_address(seeds, program)
    except ValueError:
        return None


class Run:
    def __init__(self, program, opeq, accounts, data, now, handler):
        self.program, self.opeq, self.accounts, self.data, self.now, self.handler = program, opeq, accounts, data, now, handler

    def cpi(self, prog, metas, data, signer_keys=()):
        if self.find(prog) is None:
            raise Reject(28)
        for key, s, w in metas:
            a = self.find(key)
            if a is None:
                raise Reject(28)
            if s and not a.get("signer") and key not in signer_keys:
                raise AssertionError("signer escalation in reference model")
        self.handler(prog, metas, data, self.accounts)

    def find(self, key):
        for a in self.accounts:
            if a["key"] == key:
                return a
        return None

    def need(self, n):
        if len(self.accounts) < n:
            raise Reject(3)

    def create_account(self, payer, target, space, seeds_key):
        lam = M.rent(space) - target.get("lamports", 0)
        if lam > 0:
            self.cpi(SYSTEM, [(payer["key"], True, True), (target["key"], False, True)], struct.pack("<IQ", 2, lam))
        self.cpi(SYSTEM, [(target["key"], True, True)], struct.pack("<IQ", 8, space), (seeds_key,))
        self.cpi(SYSTEM, [(target["key"], True, True)], struct.pack("<I", 1) + self.program, (seeds_key,))

    def owners_from(self, buf, pos, n):
        keys = []
        for i in range(n):
            aid, wb = bytes(buf[pos + 33 * i:pos + 33 * i + 32]), buf[pos + 33 * i + 32]
            k = pda([b"w", aid, bytes([wb])], self.opeq)
            if k is None:
                raise Reject(8)
            if k in keys:
                raise Reject(9)
            keys.append(k)
        return keys

    def load_ms(self, a):
        if a.get("owner") != self.program:
            raise Reject(13)
        d = a.get("data", b"")
        if len(d) != M.MS_LEN or bytes(d[:8]) != M.MS_MAGIC:
            raise Reject(14)
        return M.unpack_ms(d)

    def owner_index(self, ms, key):
        if key in ms["owners"]:
            return ms["owners"].index(key)
        raise Reject(15)

    def load_proposal(self, a, ms_key, pid):
        if a.get("owner") != self.program:
            raise Reject(20)
        d = a.get("data", b"")
        if len(d) < M.PR_OFF_DATA or bytes(d[:8]) != M.PR_MAGIC or bytes(d[8:40]) != ms_key:
            raise Reject(20)
        if struct.unpack_from("<I", d, M.PR_OFF_DLEN)[0] != len(d) - M.PR_OFF_DATA:
            raise Reject(20)
        p = M.unpack_proposal(d)
        if p["id"] != pid:
            raise Reject(16)
        return p

    def live(self, p, ms):
        if p["flags"] != 0 or p["config"] != ms["config"] or self.now > p["expires"]:
            raise Reject(21)

    def vault_key(self, ms_key, ms):
        return pda([b"v", ms_key, bytes([ms["vbump"]])], self.program)

    def check_stored(self, buf, vault):
        if len(buf) < 1 or len(buf) > M.MAX_DATA:
            raise Reject(18)
        n = buf[0]
        if n < 1 or n > M.MAX_IXS:
            raise Reject(18)
        pos, ixs = 1, []
        for _ in range(n):
            if pos + 33 > len(buf):
                raise Reject(18)
            prog, nm = bytes(buf[pos:pos + 32]), buf[pos + 32]
            pos += 33
            if nm > M.MAX_METAS:
                raise Reject(18)
            metas = []
            for _ in range(nm):
                if pos + 33 > len(buf):
                    raise Reject(18)
                key, fl = bytes(buf[pos:pos + 32]), buf[pos + 32]
                if fl & 0xFC:
                    raise Reject(18)
                if fl & M.M_SIGNER and key != vault:
                    raise Reject(19)
                metas.append((key, fl))
                pos += 33
            if pos + 2 > len(buf):
                raise Reject(18)
            dl, = struct.unpack_from("<H", buf, pos)
            pos += 2
            if pos + dl > len(buf):
                raise Reject(18)
            ixs.append((prog, metas, bytes(buf[pos:pos + dl])))
            pos += dl
        if pos != len(buf):
            raise Reject(18)
        return ixs


def process(program, opeq, accounts, data, now, handler):
    r = Run(program, opeq, accounts, data, now, handler)
    if len(accounts) > 64:
        raise Reject(2)
    if not data:
        raise Reject(1)
    tag = data[0]
    fn = {M.IX_CREATE: create, M.IX_PROPOSE: propose, M.IX_APPROVE: vote, M.IX_REVOKE: vote, M.IX_CANCEL: cancel, M.IX_EXECUTE: execute, M.IX_CLOSE: close}.get(tag)
    if fn is None:
        raise Reject(1)
    return fn(r, tag)


def create(r, tag):
    d = r.data
    if len(d) < 35:
        raise Reject(1)
    n = d[34]
    if n < 1 or n > M.MAX_OWNERS:
        raise Reject(6)
    if len(d) != 35 + 33 * n:
        raise Reject(1)
    r.need(3)
    creator, ms, system = r.accounts[:3]
    if not creator.get("signer"):
        raise Reject(4)
    if not creator.get("writable") or not ms.get("writable"):
        raise Reject(29)
    if system["key"] != SYSTEM:
        raise Reject(5)
    threshold = d[1]
    if threshold < 1 or threshold > n:
        raise Reject(7)
    owners = r.owners_from(d, 35, n)
    if creator["key"] not in owners:
        raise Reject(10)
    nonce = bytes(d[2:34])
    mkey, mbump = M.ms_pda(creator["key"], nonce, r.program)
    if ms["key"] != mkey:
        raise Reject(11)
    if ms.get("data") or ms.get("owner", SYSTEM) != SYSTEM:
        raise Reject(12)
    _, vbump = M.vault_pda(mkey, r.program)
    r.create_account(creator, ms, M.MS_LEN, mkey)
    body = bytearray(M.MS_LEN)
    body[0:8] = M.MS_MAGIC
    body[8:40] = creator["key"]
    body[40:72] = nonce
    struct.pack_into("<IBBBBQ", body, M.MS_OFF_CONFIG, 1, threshold, n, mbump, vbump, 0)
    for i, k in enumerate(owners):
        body[M.MS_OFF_OWNERS + 32 * i:M.MS_OFF_OWNERS + 32 * i + 32] = k
    ms["data"] = body


def propose(r, tag):
    d = r.data
    if len(d) < 10:
        raise Reject(1)
    r.need(4)
    proposer, ms_acc, prop, system = r.accounts[:4]
    if not proposer.get("signer"):
        raise Reject(4)
    if not proposer.get("writable") or not ms_acc.get("writable") or not prop.get("writable"):
        raise Reject(29)
    if system["key"] != SYSTEM:
        raise Reject(5)
    ms = r.load_ms(ms_acc)
    idx = r.owner_index(ms, proposer["key"])
    expires, = struct.unpack_from("<q", d, 1)
    if expires <= r.now or expires > r.now + M.MAX_LIFETIME:
        raise Reject(17)
    stored = bytes(d[9:])
    r.check_stored(stored, r.vault_key(ms_acc["key"], ms))
    pkey, pbump = M.proposal_pda(ms_acc["key"], ms["next"], r.program)
    if prop["key"] != pkey:
        raise Reject(16)
    if prop.get("data") or prop.get("owner", SYSTEM) != SYSTEM:
        raise Reject(12)
    space = M.PR_OFF_DATA + len(stored)
    r.create_account(proposer, prop, space, pkey)
    body = bytearray(space)
    body[0:8] = M.PR_MAGIC
    body[8:40] = ms_acc["key"]
    struct.pack_into("<QIBBHq", body, M.PR_OFF_ID, ms["next"], ms["config"], 0, pbump, 1 << idx, expires)
    body[64:96] = proposer["key"]
    body[96:128] = hashlib.sha256(stored).digest()
    struct.pack_into("<I", body, M.PR_OFF_DLEN, len(stored))
    body[M.PR_OFF_DATA:] = stored
    prop["data"] = body
    struct.pack_into("<Q", ms_acc["data"], M.MS_OFF_NEXT, ms["next"] + 1)


def vote(r, tag):
    d = r.data
    if len(d) != 41:
        raise Reject(1)
    r.need(3)
    owner, ms_acc, prop = r.accounts[:3]
    if not owner.get("signer"):
        raise Reject(4)
    if not prop.get("writable"):
        raise Reject(29)
    ms = r.load_ms(ms_acc)
    idx = r.owner_index(ms, owner["key"])
    pid, = struct.unpack_from("<Q", d, 1)
    p = r.load_proposal(prop, ms_acc["key"], pid)
    r.live(p, ms)
    if bytes(d[9:41]) != p["hash"]:
        raise Reject(22)
    bit = 1 << idx
    if tag == M.IX_APPROVE:
        if p["approvals"] & bit:
            raise Reject(23)
        v = p["approvals"] | bit
    else:
        if not p["approvals"] & bit:
            raise Reject(24)
        v = p["approvals"] & ~bit
    struct.pack_into("<H", prop["data"], M.PR_OFF_APPROVALS, v)


def cancel(r, tag):
    d = r.data
    if len(d) != 9:
        raise Reject(1)
    r.need(3)
    owner, ms_acc, prop = r.accounts[:3]
    if not owner.get("signer"):
        raise Reject(4)
    if not prop.get("writable"):
        raise Reject(29)
    ms = r.load_ms(ms_acc)
    r.owner_index(ms, owner["key"])
    pid, = struct.unpack_from("<Q", d, 1)
    p = r.load_proposal(prop, ms_acc["key"], pid)
    r.live(p, ms)
    if p["proposer"] != owner["key"]:
        raise Reject(25)
    prop["data"][M.PR_OFF_FLAGS] |= M.F_CANCELLED


def execute(r, tag):
    d = r.data
    if len(d) != 9:
        raise Reject(1)
    r.need(4)
    owner, ms_acc, prop, vault = r.accounts[:4]
    if not owner.get("signer"):
        raise Reject(4)
    if not ms_acc.get("writable") or not prop.get("writable"):
        raise Reject(29)
    ms = r.load_ms(ms_acc)
    r.owner_index(ms, owner["key"])
    pid, = struct.unpack_from("<Q", d, 1)
    p = r.load_proposal(prop, ms_acc["key"], pid)
    r.live(p, ms)
    have = bin(p["approvals"] & ((1 << ms["n"]) - 1)).count("1")
    if have < ms["threshold"]:
        raise Reject(26)
    vkey = r.vault_key(ms_acc["key"], ms)
    if vault["key"] != vkey:
        raise Reject(27)
    prop["data"][M.PR_OFF_FLAGS] |= M.F_EXECUTED
    for prog, metas, data in r.check_stored(p["data"], vkey):
        if prog == r.program:
            internal(r, ms_acc, metas, data)
        else:
            r.cpi(prog, [(k, bool(f & M.M_SIGNER), bool(f & M.M_WRITABLE)) for k, f in metas], data, (vkey,))


def internal(r, ms_acc, metas, data):
    if metas or not data:
        raise Reject(18)
    body = ms_acc["data"]
    n = body[M.MS_OFF_N]
    if data[0] == M.INNER_SET_THRESHOLD:
        if len(data) != 2:
            raise Reject(18)
        if data[1] < 1 or data[1] > n:
            raise Reject(7)
        body[M.MS_OFF_THRESHOLD] = data[1]
    elif data[0] == M.INNER_SET_OWNERS:
        if len(data) < 3:
            raise Reject(18)
        nn = data[2]
        if nn < 1 or nn > M.MAX_OWNERS:
            raise Reject(6)
        if len(data) != 3 + 33 * nn:
            raise Reject(18)
        if data[1] < 1 or data[1] > nn:
            raise Reject(7)
        owners = r.owners_from(data, 3, nn)
        body[M.MS_OFF_THRESHOLD] = data[1]
        body[M.MS_OFF_N] = nn
        body[M.MS_OFF_OWNERS:M.MS_LEN] = bytes(32 * M.MAX_OWNERS)
        for i, k in enumerate(owners):
            body[M.MS_OFF_OWNERS + 32 * i:M.MS_OFF_OWNERS + 32 * i + 32] = k
    else:
        raise Reject(18)
    cfg, = struct.unpack_from("<I", body, M.MS_OFF_CONFIG)
    struct.pack_into("<I", body, M.MS_OFF_CONFIG, cfg + 1)


def close(r, tag):
    d = r.data
    if len(d) != 9:
        raise Reject(1)
    r.need(3)
    proposer, ms_acc, prop = r.accounts[:3]
    if not proposer.get("writable") or not prop.get("writable"):
        raise Reject(29)
    ms = r.load_ms(ms_acc)
    pid, = struct.unpack_from("<Q", d, 1)
    p = r.load_proposal(prop, ms_acc["key"], pid)
    if p["proposer"] != proposer["key"]:
        raise Reject(25)
    if p["flags"] == 0 and p["config"] == ms["config"] and r.now <= p["expires"]:
        raise Reject(30)
    proposer["lamports"] = proposer.get("lamports", 0) + prop.get("lamports", 0)
    prop["lamports"] = 0
    prop["data"][0:8] = bytes(8)
