import hashlib
import struct

from solkit import find_pda_bump, on_curve

IX_CREATE = 0
IX_PROPOSE = 1
IX_APPROVE = 2
IX_REVOKE = 3
IX_CANCEL = 4
IX_EXECUTE = 5
IX_CLOSE = 6

INNER_SET_OWNERS = 0x80
INNER_SET_THRESHOLD = 0x81

MS_MAGIC = b"OPEQMS01"
PR_MAGIC = b"OPEQPR01"
MAX_OWNERS = 10
MAX_IXS = 8
MAX_METAS = 16
MAX_DATA = 900
MAX_LIFETIME = 30 * 24 * 3600
LAMPORTS_PER_BYTE = 6960
ACCOUNT_OVERHEAD = 128

MS_OFF_CREATOR = 8
MS_OFF_NONCE = 40
MS_OFF_CONFIG = 72
MS_OFF_THRESHOLD = 76
MS_OFF_N = 77
MS_OFF_MBUMP = 78
MS_OFF_VBUMP = 79
MS_OFF_NEXT = 80
MS_OFF_OWNERS = 88
MS_LEN = MS_OFF_OWNERS + 32 * MAX_OWNERS

PR_OFF_MS = 8
PR_OFF_ID = 40
PR_OFF_CONFIG = 48
PR_OFF_FLAGS = 52
PR_OFF_PBUMP = 53
PR_OFF_APPROVALS = 54
PR_OFF_EXPIRES = 56
PR_OFF_PROPOSER = 64
PR_OFF_HASH = 96
PR_OFF_DLEN = 128
PR_OFF_DATA = 132

F_EXECUTED = 1
F_CANCELLED = 2
M_SIGNER = 1
M_WRITABLE = 2

ERRORS = {
    1: "bad instruction", 2: "too many accounts", 3: "account index out of range", 4: "caller must sign",
    5: "bad system program", 6: "bad owner list", 7: "bad threshold", 8: "owner is not an OPEQ wallet",
    9: "duplicate owner", 10: "creator is not an owner", 11: "multisig address mismatch", 12: "already initialized",
    13: "multisig not owned by this program", 14: "bad multisig account", 15: "not an owner", 16: "proposal address mismatch",
    17: "bad expiry", 18: "malformed proposal", 19: "signer escalation", 20: "bad proposal account",
    21: "proposal not live", 22: "content mismatch", 23: "already approved", 24: "not approved", 25: "not the proposer",
    26: "not enough approvals", 27: "vault address mismatch", 28: "missing account for a stored instruction",
    29: "not writable", 30: "proposal still live",
}


def rent(space):
    return (ACCOUNT_OVERHEAD + space) * LAMPORTS_PER_BYTE


def create_program_address(seeds, program):
    h = hashlib.sha256(b"".join(seeds) + program + b"ProgramDerivedAddress").digest()
    if on_curve(h):
        raise ValueError("on curve")
    return h


def owner_wallet(aid, wbump, opeq_program):
    return create_program_address([b"w", aid, bytes([wbump])], opeq_program)


def ms_pda(creator, nonce, program):
    return find_pda_bump([b"m", creator, nonce], program)


def vault_pda(ms, program):
    return find_pda_bump([b"v", ms], program)


def proposal_pda(ms, pid, program):
    return find_pda_bump([b"p", ms, struct.pack("<Q", pid)], program)


def encode_owners(owners):
    out = struct.pack("<B", len(owners))
    for aid, wbump in owners:
        out += aid + bytes([wbump])
    return out


def build_create(nonce, threshold, owners):
    return struct.pack("<BB", IX_CREATE, threshold) + nonce + encode_owners(owners)


def encode_stored(ixs):
    out = struct.pack("<B", len(ixs))
    for prog, metas, data in ixs:
        out += prog + struct.pack("<B", len(metas))
        for key, flags in metas:
            out += key + bytes([flags])
        out += struct.pack("<H", len(data)) + data
    return out


def decode_stored(buf, vault):
    if not buf:
        raise ValueError("empty")
    n = buf[0]
    if n < 1 or n > MAX_IXS:
        raise ValueError("ix count")
    pos, ixs = 1, []
    for _ in range(n):
        if pos + 33 > len(buf):
            raise ValueError("truncated")
        prog, nm = bytes(buf[pos:pos + 32]), buf[pos + 32]
        pos += 33
        if nm > MAX_METAS:
            raise ValueError("metas")
        metas = []
        for _ in range(nm):
            if pos + 33 > len(buf):
                raise ValueError("truncated")
            key, fl = bytes(buf[pos:pos + 32]), buf[pos + 32]
            if fl & ~3:
                raise ValueError("flags")
            if fl & M_SIGNER and key != vault:
                raise ValueError("signer")
            metas.append((key, fl))
            pos += 33
        if pos + 2 > len(buf):
            raise ValueError("truncated")
        dl, = struct.unpack_from("<H", buf, pos)
        pos += 2
        if pos + dl > len(buf):
            raise ValueError("truncated")
        ixs.append((prog, metas, bytes(buf[pos:pos + dl])))
        pos += dl
    if pos != len(buf):
        raise ValueError("trailing")
    return ixs


def build_propose(expires, stored):
    return struct.pack("<Bq", IX_PROPOSE, expires) + stored


def build_vote(tag, pid, h):
    return struct.pack("<BQ", tag, pid) + h


def build_cancel(pid):
    return struct.pack("<BQ", IX_CANCEL, pid)


def build_execute(pid):
    return struct.pack("<BQ", IX_EXECUTE, pid)


def build_close(pid):
    return struct.pack("<BQ", IX_CLOSE, pid)


def set_owners_data(threshold, owners):
    return struct.pack("<BB", INNER_SET_OWNERS, threshold) + encode_owners(owners)


def set_threshold_data(threshold):
    return struct.pack("<BB", INNER_SET_THRESHOLD, threshold)


def unpack_ms(data):
    if len(data) != MS_LEN or bytes(data[:8]) != MS_MAGIC:
        raise ValueError("not a multisig account")
    n = data[MS_OFF_N]
    return {
        "creator": bytes(data[8:40]), "nonce": bytes(data[40:72]),
        "config": struct.unpack_from("<I", data, MS_OFF_CONFIG)[0], "threshold": data[MS_OFF_THRESHOLD], "n": n,
        "mbump": data[MS_OFF_MBUMP], "vbump": data[MS_OFF_VBUMP], "next": struct.unpack_from("<Q", data, MS_OFF_NEXT)[0],
        "owners": [bytes(data[MS_OFF_OWNERS + 32 * i:MS_OFF_OWNERS + 32 * i + 32]) for i in range(n)],
    }


def unpack_proposal(data):
    if len(data) < PR_OFF_DATA or bytes(data[:8]) != PR_MAGIC:
        raise ValueError("not a proposal account")
    dl, = struct.unpack_from("<I", data, PR_OFF_DLEN)
    if len(data) != PR_OFF_DATA + dl:
        raise ValueError("bad proposal length")
    return {
        "ms": bytes(data[8:40]), "id": struct.unpack_from("<Q", data, PR_OFF_ID)[0],
        "config": struct.unpack_from("<I", data, PR_OFF_CONFIG)[0], "flags": data[PR_OFF_FLAGS], "pbump": data[PR_OFF_PBUMP],
        "approvals": struct.unpack_from("<H", data, PR_OFF_APPROVALS)[0], "expires": struct.unpack_from("<q", data, PR_OFF_EXPIRES)[0],
        "proposer": bytes(data[64:96]), "hash": bytes(data[96:128]), "data": bytes(data[PR_OFF_DATA:]),
    }
