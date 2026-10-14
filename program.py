import itertools
import sys

import protocol as P
import wots
from asm import Asm, Reg, r0, r1, r2, r3, r4, r5, r6, r7, r8, r9

HEAP = 3 << 32

ACC = 0x000
NUM = 0x200
SV3 = 0x208
FBUF = 0x210
FSL = 0x240
OUT = 0x250
NBUF = 0x270
NSL = 0x2B0
DIG = 0x2C0
CLK = 0x2D8
LBUF = 0x300
LSL = 0x440
SIGNERS = 0x450
SEEDS = 0x460
AID = 0x490
IX = 0x4B0
BUMPS = 0x4D8
VLEAF = 0x4E0
VSIG = 0x4E8
VPATH = 0x4F0
SYSD = 0x4F8
TMP = 0x520
TMP2 = 0x528
SV4 = 0x530
SV6 = 0x538
METAS = 0x540
INFOS = 0x940
SLICES = 0x1740
SL_END = 0x8000
MAX_ACCOUNTS = 64
MAX_METAS = 64

SD = 88
ACC_SIGNER = 1
ACC_WRITABLE = 2
ACC_EXEC = 3
ACC_KEY = 8
ACC_OWNER = 40
ACC_LAMPORTS = 72
ACC_DLEN = 80
ACC_DATA = 88

MAGIC = int.from_bytes(P.STATE_MAGIC, "little")

_ids = itertools.count()


def uniq(prefix):
    return f"{prefix}_{next(_ids)}"


def heap_ptr(a, reg, off):
    a.mov(reg, r9)
    a.add(reg, off)


def prog_id(a, reg):
    a.mov(reg, r8)
    a.add(reg, r7)


def acc(a, reg, idx):
    a.ldx(8, reg, r9, ACC + 8 * idx)


def acc_dyn(a, reg, idx_reg):
    if reg != idx_reg:
        a.mov(reg, idx_reg)
    a.lsh(reg, 3)
    a.add(reg, r9)
    a.ldx(8, reg, reg, ACC)


def need(a, n):
    a.ldx(8, r0, r9, NUM)
    a.jlt(r0, n, "err17")


def slice_(a, cur, addr_reg, length):
    a.stx(8, cur, 0, addr_reg)
    if isinstance(length, Reg):
        a.stx(8, cur, 8, length)
    else:
        a.st(8, cur, 8, length)
    a.add(cur, 16)


def slice_ro(a, cur, label, length, tmp=r0):
    a.lddw(tmp, label)
    slice_(a, cur, tmp, length)


def copy(a, dst, doff, src, soff, n, tmp=r0):
    for i in range(0, n, 8):
        a.ldx(8, tmp, src, soff + i)
        a.stx(8, dst, doff + i, tmp)


def set_seed(a, idx, addr_reg, length):
    a.stx(8, r9, SEEDS + 16 * idx, addr_reg)
    a.st(8, r9, SEEDS + 16 * idx + 8, length)


def sha(a, slices_off, count):
    heap_ptr(a, r1, slices_off)
    a.mov(r2, count)
    heap_ptr(a, r3, OUT)
    a.syscall("sol_sha256")


VERSION = b"opeq/1.1"


def build(version=VERSION):
    a = Asm()
    a.data("version", version)
    a.data("tag_exec", P.TAG_EXEC)
    a.data("tag_rekey", P.TAG_REKEY)
    a.data("tag_id", b"opeq/id/v1")
    a.data("seed_s", b"s")
    a.data("seed_w", b"w")

    a.label("entrypoint")
    a.mov(r8, r2)
    a.ldx(8, r7, r8, -8)
    a.lddw(r9, HEAP)
    a.ldx(8, r3, r1, 0)
    a.jgt(r3, MAX_ACCOUNTS, "err2")
    a.stx(8, r9, NUM, r3)
    a.mov(r4, r1)
    a.add(r4, 8)
    a.mov(r5, 0)
    a.label("walk")
    a.jge(r5, r3, "walked")
    a.ldx(1, r0, r4, 0)
    a.mov(r6, r5)
    a.lsh(r6, 3)
    a.add(r6, r9)
    a.jne(r0, 0xFF, "walk_dup")
    a.stx(8, r6, ACC, r4)
    a.ldx(8, r0, r4, ACC_DLEN)
    a.add(r0, 7)
    a.and_(r0, -8)
    a.add(r0, 10336)
    a.add(r4, r0)
    a.add(r5, 1)
    a.ja("walk")
    a.label("walk_dup")
    a.lsh(r0, 3)
    a.add(r0, r9)
    a.ldx(8, r0, r0, ACC)
    a.stx(8, r6, ACC, r0)
    a.add(r4, 8)
    a.add(r5, 1)
    a.ja("walk")
    a.label("walked")
    a.jeq(r7, 0, "err1")
    a.ldx(1, r0, r8, 0)
    a.jeq(r0, P.IX_INIT, "do_init")
    a.jeq(r0, P.IX_EXEC, "do_exec")
    a.jeq(r0, P.IX_REKEY, "do_rekey")
    a.ja("err1")

    emit_exec(a)
    emit_rekey(a)
    emit_init(a)

    for code in sorted(P.ERRORS):
        a.label(f"err{code}")
        a.mov(r0, code)
        a.exit()

    emit_eq32(a)
    emit_build_infos(a)
    emit_wots_verify(a)
    return a


def emit_load_state(a):
    need(a, 2)
    acc(a, r6, 0)
    a.mov(r1, r6)
    a.add(r1, ACC_OWNER)
    prog_id(a, r2)
    a.call("eq32")
    a.jne(r0, 0, "err3")
    a.ldx(1, r0, r6, ACC_WRITABLE)
    a.jeq(r0, 0, "err14")
    a.ldx(8, r0, r6, ACC_DLEN)
    a.jlt(r0, P.STATE_LEN, "err4")
    a.ldx(8, r0, r6, ACC_DATA)
    a.lddw(r1, MAGIC)
    a.jne(r0, r1, "err4")
    a.lddw(r1, "seed_s")
    set_seed(a, 0, r1, 1)
    a.mov(r1, r6)
    a.add(r1, ACC_DATA + P.OFF_ID)
    set_seed(a, 1, r1, 32)
    a.mov(r1, r6)
    a.add(r1, ACC_DATA + P.OFF_SBUMP)
    set_seed(a, 2, r1, 1)
    heap_ptr(a, r1, SEEDS)
    a.mov(r2, 3)
    prog_id(a, r3)
    heap_ptr(a, r4, OUT)
    a.syscall("sol_create_program_address")
    a.jne(r0, 0, "err5")
    heap_ptr(a, r1, OUT)
    a.mov(r2, r6)
    a.add(r2, ACC_KEY)
    a.call("eq32")
    a.jne(r0, 0, "err5")
    a.lddw(r1, "seed_w")
    set_seed(a, 0, r1, 1)
    a.mov(r1, r6)
    a.add(r1, ACC_DATA + P.OFF_WBUMP)
    set_seed(a, 2, r1, 1)
    heap_ptr(a, r1, SEEDS)
    a.mov(r2, 3)
    prog_id(a, r3)
    heap_ptr(a, r4, OUT)
    a.syscall("sol_create_program_address")
    a.jne(r0, 0, "err5")
    heap_ptr(a, r1, OUT)
    acc(a, r2, 1)
    a.add(r2, ACC_KEY)
    a.call("eq32")
    a.jne(r0, 0, "err5")
    heap_ptr(a, r1, SEEDS)
    a.stx(8, r9, SIGNERS, r1)
    a.st(8, r9, SIGNERS + 8, 3)


def emit_leaf_checks(a, limit):
    heap_ptr(a, r1, CLK)
    a.syscall("sol_get_clock_sysvar")
    a.ldx(8, r1, r9, CLK)
    a.ldx(8, r2, r8, 5)
    a.jgt(r1, r2, "err6")
    a.add(r1, P.MAX_EXPIRY_WINDOW)
    a.jgt(r2, r1, "err23")
    a.ldx(4, r1, r8, 1)
    a.ldx(4, r2, r6, ACC_DATA + P.OFF_NEXT)
    a.jlt(r1, r2, "err7")
    a.jge(r1, limit, "err8")


def emit_common_prefix_slices(a, tag, taglen):
    heap_ptr(a, r5, SLICES)
    a.mov(r1, r8)
    a.add(r1, P.R_OFF)
    slice_(a, r5, r1, P.R_LEN)
    slice_ro(a, r5, tag, taglen)
    prog_id(a, r1)
    slice_(a, r5, r1, 32)
    a.mov(r1, r6)
    a.add(r1, ACC_DATA + P.OFF_ID)
    slice_(a, r5, r1, 32)
    a.mov(r1, r6)
    a.add(r1, ACC_DATA + P.OFF_EPOCH)
    slice_(a, r5, r1, 4)
    a.mov(r1, r8)
    a.add(r1, 1)
    slice_(a, r5, r1, 12)


def emit_salt_slice(a):
    a.mov(r1, r8)
    a.add(r1, P.SALT_OFF)
    slice_(a, r5, r1, 4)


def emit_verify_call(a):
    a.mov(r2, r5)
    a.sub(r2, r9)
    a.sub(r2, SLICES)
    a.rsh(r2, 4)
    heap_ptr(a, r1, SLICES)
    heap_ptr(a, r3, OUT)
    a.syscall("sol_sha256")
    a.ldx(4, r1, r8, 1)
    a.stx(8, r9, VLEAF, r1)
    a.mov(r1, r8)
    a.add(r1, P.SIG_OFF)
    a.stx(8, r9, VSIG, r1)
    a.add(r1, wots.SIG_LEN)
    a.stx(8, r9, VPATH, r1)
    a.call("wots_verify")
    a.jne(r0, 0, "err13")


def bounds(a, need_bytes, err="err12"):
    a.mov(r0, r4)
    a.add(r0, need_bytes)
    prog_id(a, r1)
    a.jgt(r0, r1, err)


def emit_exec(a):
    n_off = P.TAIL_OFF
    a.label("do_exec")
    a.jlt(r7, P.EXEC_FIXED, "err1")
    emit_load_state(a)
    emit_leaf_checks(a, P.EXEC_LEAF_LIMIT)
    emit_common_prefix_slices(a, "tag_exec", len(P.TAG_EXEC))
    a.mov(r1, r8)
    a.add(r1, n_off)
    slice_(a, r5, r1, 1)
    a.ldx(1, r3, r8, n_off)
    a.mov(r4, r8)
    a.add(r4, n_off + 1)

    a.label("inner_loop")
    a.jeq(r3, 0, "inner_done")
    a.mov(r0, r5)
    a.add(r0, 16 * (4 + 2 * MAX_METAS))
    a.mov(r1, r9)
    a.add(r1, SL_END)
    a.jgt(r0, r1, "err16")
    bounds(a, 2)
    a.ldx(1, r1, r4, 0)
    a.ldx(8, r0, r9, NUM)
    a.jge(r1, r0, "err17")
    a.ldx(1, r2, r4, 1)
    a.jgt(r2, MAX_METAS, "err21")
    acc_dyn(a, r1, r1)
    a.add(r1, ACC_KEY)
    slice_(a, r5, r1, 32)
    a.stx(8, r9, TMP2, r2)
    prog_id(a, r2)
    a.call("eq32")
    a.ldx(8, r2, r9, TMP2)
    a.jeq(r0, 0, "err9")
    a.mov(r1, r4)
    a.add(r1, 1)
    slice_(a, r5, r1, 1)
    a.add(r4, 2)

    a.label("meta_loop")
    a.jeq(r2, 0, "meta_done")
    bounds(a, 2)
    a.ldx(1, r1, r4, 0)
    a.ldx(8, r0, r9, NUM)
    a.jge(r1, r0, "err17")
    a.ldx(1, r0, r4, 1)
    a.jset(r0, 0xFC, "err10")
    acc_dyn(a, r1, r1)
    a.jset(r0, P.F_SIGNER, "meta_signer")
    a.label("meta_ok")
    a.add(r1, ACC_KEY)
    slice_(a, r5, r1, 32)
    a.mov(r1, r4)
    a.add(r1, 1)
    slice_(a, r5, r1, 1)
    a.add(r4, 2)
    a.sub(r2, 1)
    a.ja("meta_loop")
    a.label("meta_signer")
    a.ldx(1, r0, r1, ACC_SIGNER)
    a.jne(r0, 0, "meta_ok")
    a.stx(8, r9, TMP, r1)
    a.stx(8, r9, TMP2, r2)
    a.add(r1, ACC_KEY)
    acc(a, r2, 1)
    a.add(r2, ACC_KEY)
    a.call("eq32")
    a.ldx(8, r1, r9, TMP)
    a.ldx(8, r2, r9, TMP2)
    a.jne(r0, 0, "err11")
    a.ja("meta_ok")

    a.label("meta_done")
    bounds(a, 2)
    a.ldx(2, r0, r4, 0)
    a.add(r0, 2)
    a.mov(r2, r4)
    a.add(r2, r0)
    prog_id(a, r1)
    a.jgt(r2, r1, "err12")
    slice_(a, r5, r4, r0)
    a.mov(r4, r2)
    a.sub(r3, 1)
    a.ja("inner_loop")

    a.label("inner_done")
    prog_id(a, r1)
    a.jne(r4, r1, "err12")
    emit_salt_slice(a)
    emit_verify_call(a)
    a.ldx(4, r1, r8, 1)
    a.add(r1, 1)
    a.stx(4, r6, ACC_DATA + P.OFF_NEXT, r1)
    a.call("build_infos")

    a.ldx(1, r3, r8, n_off)
    a.mov(r4, r8)
    a.add(r4, n_off + 1)
    a.label("cpi_loop")
    a.jeq(r3, 0, "cpi_done")
    a.ldx(1, r1, r4, 0)
    acc_dyn(a, r1, r1)
    a.add(r1, ACC_KEY)
    a.stx(8, r9, IX, r1)
    heap_ptr(a, r1, METAS)
    a.stx(8, r9, IX + 8, r1)
    a.ldx(1, r2, r4, 1)
    a.stx(8, r9, IX + 16, r2)
    a.add(r4, 2)
    heap_ptr(a, r5, METAS)
    a.label("cm_loop")
    a.jeq(r2, 0, "cm_done")
    a.ldx(1, r1, r4, 0)
    acc_dyn(a, r1, r1)
    a.add(r1, ACC_KEY)
    a.stx(8, r5, 0, r1)
    a.st(8, r5, 8, 0)
    a.ldx(1, r0, r4, 1)
    a.mov(r1, r0)
    a.rsh(r1, 1)
    a.and_(r1, 1)
    a.stx(1, r5, 8, r1)
    a.and_(r0, 1)
    a.stx(1, r5, 9, r0)
    a.add(r5, 16)
    a.add(r4, 2)
    a.sub(r2, 1)
    a.ja("cm_loop")
    a.label("cm_done")
    a.ldx(2, r0, r4, 0)
    a.stx(8, r9, IX + 32, r0)
    a.add(r4, 2)
    a.stx(8, r9, IX + 24, r4)
    a.add(r4, r0)
    a.stx(8, r9, SV3, r3)
    a.stx(8, r9, SV4, r4)
    emit_invoke(a)
    a.ldx(8, r3, r9, SV3)
    a.ldx(8, r4, r9, SV4)
    a.sub(r3, 1)
    a.ja("cpi_loop")
    a.label("cpi_done")
    a.mov(r0, 0)
    a.exit()


def emit_invoke(a):
    heap_ptr(a, r1, IX)
    heap_ptr(a, r2, INFOS)
    a.ldx(8, r3, r9, NUM)
    heap_ptr(a, r4, SIGNERS)
    a.mov(r5, 1)
    a.syscall("sol_invoke_signed_c")


def emit_rekey(a):
    a.label("do_rekey")
    a.jne(r7, P.REKEY_LEN, "err1")
    emit_load_state(a)
    emit_leaf_checks(a, wots.LEAVES)
    new_off = P.TAIL_OFF
    a.ldx(8, r0, r8, new_off + wots.N)
    a.ldx(8, r1, r6, ACC_DATA + P.OFF_ROOT)
    a.jne(r0, r1, "rekey_new_root")
    a.ldx(8, r0, r8, new_off + wots.N + 8)
    a.ldx(8, r1, r6, ACC_DATA + P.OFF_ROOT + 8)
    a.jeq(r0, r1, "err22")
    a.label("rekey_new_root")
    emit_common_prefix_slices(a, "tag_rekey", len(P.TAG_REKEY))
    a.mov(r1, r8)
    a.add(r1, new_off)
    slice_(a, r5, r1, 32)
    emit_salt_slice(a)
    emit_verify_call(a)
    copy(a, r6, ACC_DATA + P.OFF_PUB_SEED, r8, new_off, 32)
    a.st(4, r6, ACC_DATA + P.OFF_NEXT, 0)
    a.ldx(4, r0, r6, ACC_DATA + P.OFF_EPOCH)
    a.add(r0, 1)
    a.stx(4, r6, ACC_DATA + P.OFF_EPOCH, r0)
    a.mov(r0, 0)
    a.exit()


def emit_sys_cpi(a, metas, dlen):
    acc(a, r1, 3)
    a.add(r1, ACC_KEY)
    a.stx(8, r9, IX, r1)
    heap_ptr(a, r1, METAS)
    a.stx(8, r9, IX + 8, r1)
    a.st(8, r9, IX + 16, len(metas))
    heap_ptr(a, r1, SYSD)
    a.stx(8, r9, IX + 24, r1)
    a.st(8, r9, IX + 32, dlen)
    for i, (idx, writable, signer) in enumerate(metas):
        acc(a, r1, idx)
        a.add(r1, ACC_KEY)
        a.stx(8, r9, METAS + 16 * i, r1)
        a.st(8, r9, METAS + 16 * i + 8, 0)
        a.st(1, r9, METAS + 16 * i + 8, int(writable))
        a.st(1, r9, METAS + 16 * i + 9, int(signer))
    emit_invoke(a)


def emit_init(a):
    a.label("do_init")
    a.jne(r7, P.INIT_LEN, "err1")
    need(a, 4)
    heap_ptr(a, r5, SLICES)
    slice_ro(a, r5, "tag_id", 10)
    a.mov(r1, r8)
    a.add(r1, 1)
    slice_(a, r5, r1, 32)
    heap_ptr(a, r1, SLICES)
    a.mov(r2, 2)
    heap_ptr(a, r3, AID)
    a.syscall("sol_sha256")
    heap_ptr(a, r1, AID)
    set_seed(a, 1, r1, 32)
    for label, bump_off, idx in (("seed_s", 0, 1), ("seed_w", 1, 2)):
        a.lddw(r1, label)
        set_seed(a, 0, r1, 1)
        heap_ptr(a, r1, SEEDS)
        a.mov(r2, 2)
        prog_id(a, r3)
        heap_ptr(a, r4, OUT)
        heap_ptr(a, r5, BUMPS + bump_off)
        a.syscall("sol_try_find_program_address")
        a.jne(r0, 0, "err15")
        heap_ptr(a, r1, OUT)
        acc(a, r2, idx)
        a.add(r2, ACC_KEY)
        a.call("eq32")
        a.jne(r0, 0, "err15")
    acc(a, r1, 3)
    for i in range(4):
        a.ldx(8, r0, r1, ACC_KEY + 8 * i)
        a.jne(r0, 0, "err20")
    acc(a, r1, 0)
    a.ldx(1, r0, r1, ACC_SIGNER)
    a.jeq(r0, 0, "err18")
    acc(a, r6, 1)
    a.ldx(8, r0, r6, ACC_DLEN)
    a.jne(r0, 0, "err19")

    a.lddw(r1, "seed_s")
    set_seed(a, 0, r1, 1)
    heap_ptr(a, r1, BUMPS)
    set_seed(a, 2, r1, 1)
    heap_ptr(a, r1, SEEDS)
    a.stx(8, r9, SIGNERS, r1)
    a.st(8, r9, SIGNERS + 8, 3)
    a.call("build_infos")

    a.ldx(8, r1, r8, 33)
    a.ldx(8, r2, r6, ACC_LAMPORTS)
    a.jge(r2, r1, "init_funded")
    a.sub(r1, r2)
    a.st(4, r9, SYSD, 2)
    a.stx(8, r9, SYSD + 4, r1)
    emit_sys_cpi(a, [(0, True, True), (1, True, False)], 12)
    a.label("init_funded")
    a.st(4, r9, SYSD, 8)
    a.st(8, r9, SYSD + 4, P.STATE_LEN)
    emit_sys_cpi(a, [(1, True, True)], 12)
    a.st(4, r9, SYSD, 1)
    prog_id(a, r2)
    copy(a, r9, SYSD + 4, r2, 0, 32)
    emit_sys_cpi(a, [(1, True, True)], 36)

    acc(a, r6, 1)
    a.lddw(r1, MAGIC)
    a.stx(8, r6, ACC_DATA, r1)
    copy(a, r6, ACC_DATA + P.OFF_ID, r9, AID, 32)
    copy(a, r6, ACC_DATA + P.OFF_PUB_SEED, r8, 1, 32)
    a.st(8, r6, ACC_DATA + P.OFF_NEXT, 0)
    a.st(8, r6, ACC_DATA + P.OFF_SBUMP, 0)
    a.ldx(1, r0, r9, BUMPS)
    a.stx(1, r6, ACC_DATA + P.OFF_SBUMP, r0)
    a.ldx(1, r0, r9, BUMPS + 1)
    a.stx(1, r6, ACC_DATA + P.OFF_WBUMP, r0)
    a.mov(r0, 0)
    a.exit()


def emit_eq32(a):
    a.label("eq32")
    for i in range(4):
        a.ldx(8, r6, r1, 8 * i)
        a.ldx(8, r7, r2, 8 * i)
        a.jne(r6, r7, "eq32_ne")
    a.mov(r0, 0)
    a.exit()
    a.label("eq32_ne")
    a.mov(r0, 1)
    a.exit()


def emit_build_infos(a):
    a.label("build_infos")
    a.ldx(8, r3, r9, NUM)
    a.mov(r5, 0)
    heap_ptr(a, r4, INFOS)
    a.label("bi_loop")
    a.jge(r5, r3, "bi_done")
    acc_dyn(a, r1, r5)
    for field, off in ((0, ACC_KEY), (8, ACC_LAMPORTS), (24, ACC_DATA), (32, ACC_OWNER)):
        a.mov(r0, r1)
        a.add(r0, off)
        a.stx(8, r4, field, r0)
    a.ldx(8, r0, r1, ACC_DLEN)
    a.stx(8, r4, 16, r0)
    a.st(8, r4, 40, -1)
    a.st(8, r4, 48, 0)
    for field, off in ((48, ACC_SIGNER), (49, ACC_WRITABLE), (50, ACC_EXEC)):
        a.ldx(1, r0, r1, off)
        a.stx(1, r4, field, r0)
    a.add(r4, 56)
    a.add(r5, 1)
    a.ja("bi_loop")
    a.label("bi_done")
    a.exit()


def emit_wots_verify(a):
    a.label("wots_verify")
    a.stx(8, r9, SV6, r6)
    copy(a, r9, DIG, r9, OUT, 16)
    a.mov(r1, 0)
    a.mov(r2, 0)
    a.label("cs_loop")
    a.jge(r2, wots.N, "cs_done")
    a.mov(r3, r9)
    a.add(r3, r2)
    a.ldx(1, r3, r3, DIG)
    a.mov(r4, wots.W - 1)
    a.sub(r4, r3)
    a.add(r1, r4)
    a.add(r2, 1)
    a.ja("cs_loop")
    a.label("cs_done")
    a.mov(r3, r1)
    a.rsh(r3, 8)
    a.stx(1, r9, DIG + 16, r3)
    a.and_(r1, 255)
    a.stx(1, r9, DIG + 17, r1)

    a.ldx(8, r7, r9, VLEAF)
    for buf in (FBUF, LBUF, NBUF):
        copy(a, r9, buf, r6, ACC_DATA + P.OFF_PUB_SEED, 16)
        a.st(8, r9, buf + 16, 0)
    a.stx(4, r9, FBUF + 20, r7)
    a.st(1, r9, LBUF + 16, wots.T_LEAF)
    a.stx(4, r9, LBUF + 20, r7)
    a.st(1, r9, NBUF + 16, wots.T_NODE)
    for sl, buf, ln in ((FSL, FBUF, 40), (LSL, LBUF, 24 + wots.SIG_LEN), (NSL, NBUF, 56)):
        heap_ptr(a, r1, buf)
        a.stx(8, r9, sl, r1)
        a.st(8, r9, sl + 8, ln)

    a.mov(r6, 0)
    a.label("chain_loop")
    a.jge(r6, wots.CHAINS, "chains_done")
    a.stx(1, r9, FBUF + 17, r6)
    a.ldx(8, r1, r9, VSIG)
    a.mov(r2, r6)
    a.lsh(r2, 4)
    a.add(r1, r2)
    copy(a, r9, FBUF + 24, r1, 0, 16)
    a.mov(r1, r9)
    a.add(r1, r6)
    a.ldx(1, r7, r1, DIG)
    a.label("step_loop")
    a.jge(r7, wots.W - 1, "step_done")
    a.stx(1, r9, FBUF + 18, r7)
    sha(a, FSL, 1)
    copy(a, r9, FBUF + 24, r9, OUT, 16)
    a.add(r7, 1)
    a.ja("step_loop")
    a.label("step_done")
    a.mov(r1, r6)
    a.lsh(r1, 4)
    a.add(r1, r9)
    copy(a, r1, LBUF + 24, r9, FBUF + 24, 16)
    a.add(r6, 1)
    a.ja("chain_loop")

    a.label("chains_done")
    sha(a, LSL, 1)
    a.ldx(8, r7, r9, VLEAF)
    a.mov(r6, 0)
    a.label("tree_loop")
    a.jge(r6, wots.HEIGHT, "tree_done")
    a.ldx(8, r1, r9, VPATH)
    a.mov(r2, r6)
    a.lsh(r2, 4)
    a.add(r1, r2)
    a.mov(r0, r6)
    a.add(r0, 1)
    a.stx(1, r9, NBUF + 17, r0)
    a.mov(r2, r7)
    a.rsh(r2, r0)
    a.stx(4, r9, NBUF + 20, r2)
    a.mov(r2, r7)
    a.rsh(r2, r6)
    a.and_(r2, 1)
    a.jeq(r2, 0, "left_is_x")
    copy(a, r9, NBUF + 40, r9, OUT, 16)
    copy(a, r9, NBUF + 24, r1, 0, 16)
    a.ja("hash_node")
    a.label("left_is_x")
    copy(a, r9, NBUF + 24, r9, OUT, 16)
    copy(a, r9, NBUF + 40, r1, 0, 16)
    a.label("hash_node")
    sha(a, NSL, 1)
    a.add(r6, 1)
    a.ja("tree_loop")

    a.label("tree_done")
    a.ldx(8, r6, r9, SV6)
    a.ldx(8, r0, r9, OUT)
    a.ldx(8, r1, r6, ACC_DATA + P.OFF_ROOT)
    a.jne(r0, r1, "wv_bad")
    a.ldx(8, r0, r9, OUT + 8)
    a.ldx(8, r1, r6, ACC_DATA + P.OFF_ROOT + 8)
    a.jne(r0, r1, "wv_bad")
    a.mov(r0, 0)
    a.exit()
    a.label("wv_bad")
    a.mov(r0, 1)
    a.exit()


if __name__ == "__main__":
    elf = build().elf()
    open(sys.argv[1], "wb").write(elf)
    print(len(elf), "bytes")
