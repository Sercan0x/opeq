import hashlib
import struct

from asm import syscall_hash
from solkit import on_curve

MM_RO = 0
MM_TEXT = 1 << 32
MM_STACK = 2 << 32
MM_HEAP = 3 << 32
MM_INPUT = 4 << 32
FRAME = 4096
MAX_DEPTH = 64
HEAP_LEN = 32 * 1024
DATA_PAD = 10240
U64 = (1 << 64) - 1


class Fault(Exception):
    pass


def sext32(v):
    v &= 0xffffffff
    return v - (1 << 32) if v & 0x80000000 else v


def to_s64(v):
    v &= U64
    return v - (1 << 64) if v >> 63 else v


def serialize(accounts, data, program):
    buf = bytearray(struct.pack("<Q", len(accounts)))
    spots = []
    seen = {}
    for i, a in enumerate(accounts):
        if a["key"] in seen:
            buf += bytes([seen[a["key"]]]) + bytes(7)
            spots.append(spots[seen[a["key"]]])
            continue
        seen[a["key"]] = i
        start = len(buf)
        buf += bytes([0xFF, a.get("signer", False), a.get("writable", False), a.get("executable", False)]) + bytes(4)
        buf += a["key"] + a.get("owner", bytes(32))
        buf += struct.pack("<QQ", a.get("lamports", 0), len(a.get("data", b"")))
        buf += bytes(a.get("data", b""))
        pad = (8 - len(a.get("data", b"")) % 8) % 8
        buf += bytes(DATA_PAD + pad)
        buf += struct.pack("<Q", U64)
        spots.append(start)
    buf += struct.pack("<Q", len(data))
    data_off = len(buf)
    buf += data + program
    return buf, spots, data_off


def deserialize(buf, accounts, spots):
    done = set()
    for a, s in zip(accounts, spots):
        if s in done:
            continue
        done.add(s)
        a["owner"] = bytes(buf[s + 40:s + 72])
        a["lamports"], dl = struct.unpack_from("<QQ", buf, s + 72)
        a["data"] = bytearray(buf[s + 88:s + 88 + dl])


class Vm:
    def __init__(self, elf, accounts, data, program, slot=1000, cu_limit=1_400_000, cpi_handler=None):
        self.load_elf(elf)
        self.accounts = accounts
        self.program = program
        self.ix_data = data
        self.input, self.spots, data_off = serialize(accounts, data, program)
        self.stack = bytearray(FRAME * MAX_DEPTH)
        self.heap = bytearray(HEAP_LEN)
        self.reg = [0] * 11
        self.reg[1] = MM_INPUT
        self.reg[2] = MM_INPUT + data_off
        self.reg[10] = MM_STACK + FRAME
        self.slot = slot
        self.cu = cu_limit
        self.cu_limit = cu_limit
        self.logs = []
        self.cpis = []
        self.cpi_handler = cpi_handler
        self.frames = []
        self.sys = {syscall_hash(n): getattr(self, "sys_" + n.rstrip("_")) for n in (
            "sol_log_", "sol_log_64_", "sol_log_pubkey", "sol_sha256", "sol_get_clock_sysvar",
            "sol_memcpy_", "sol_memcmp_", "sol_memset_", "sol_invoke_signed_c",
            "sol_create_program_address", "sol_try_find_program_address", "sol_log_compute_units_", "abort", "sol_panic_")}

    def load_elf(self, elf):
        if elf[:4] != b"\x7fELF" or struct.unpack_from("<I", elf, 48)[0] != 3:
            raise Fault("not a v3 elf")
        entry, = struct.unpack_from("<Q", elf, 24)
        phnum, = struct.unpack_from("<H", elf, 56)
        self.ro = b""
        self.text = b""
        for i in range(phnum):
            p_type, p_flags, off, vaddr, _, filesz, _, _ = struct.unpack_from("<IIQQQQQQ", elf, 64 + 56 * i)
            seg = elf[off:off + filesz]
            if p_flags == 4:
                self.ro = seg
            elif p_flags == 1:
                self.text = seg
        self.pc = (entry - MM_TEXT) // 8

    def region(self, addr, n, write):
        top = addr >> 32
        off = addr & 0xffffffff
        if top == 0 and not write:
            mem = self.ro
        elif top == 2:
            mem = self.stack
        elif top == 3:
            mem = self.heap
        elif top == 4:
            mem = self.input
        else:
            raise Fault(f"access violation {'write' if write else 'read'} {addr:#x}")
        if off + n > len(mem):
            raise Fault(f"access violation {'write' if write else 'read'} {addr:#x}+{n}")
        return mem, off

    def read(self, addr, n):
        mem, off = self.region(addr, n, False)
        return bytes(mem[off:off + n])

    def write(self, addr, blob):
        mem, off = self.region(addr, len(blob), True)
        mem[off:off + len(blob)] = blob

    def rd(self, addr, size):
        return int.from_bytes(self.read(addr, size), "little")

    def wr(self, addr, size, v):
        self.write(addr, (v & ((1 << (8 * size)) - 1)).to_bytes(size, "little"))

    def charge(self, n):
        self.cu -= n
        if self.cu < 0:
            raise Fault("compute budget exceeded")

    def slices(self, addr, n):
        out = []
        for i in range(n):
            a, l = struct.unpack("<QQ", self.read(addr + 16 * i, 16))
            out.append(self.read(a, l))
        return out

    def sys_sol_log(self, a, n, *_):
        self.charge(max(100, n))
        self.logs.append(self.read(a, n).decode("utf-8", "replace"))

    def sys_sol_log_64(self, *args):
        self.charge(100)
        self.logs.append(", ".join(f"{x:#x}" for x in args))

    def sys_sol_log_pubkey(self, a, *_):
        from solkit import ps
        self.charge(100)
        self.logs.append(ps(self.read(a, 32)))

    def sys_sol_log_compute_units(self, *_):
        self.charge(100)
        self.logs.append(f"cu remaining {self.cu}")

    def sys_sol_sha256(self, vals, n, out, *_):
        self.charge(85)
        h = hashlib.sha256()
        for s in self.slices(vals, n):
            self.charge(max(10, len(s) // 2))
            h.update(s)
        self.write(out, h.digest())

    def sys_sol_get_clock_sysvar(self, out, *_):
        if out >= MM_INPUT:
            raise Fault("sysvar into input region")
        self.charge(140)
        self.write(out, struct.pack("<QqQQq", self.slot, 0, 0, 0, 0))

    def sys_sol_memcpy(self, d, s, n, *_):
        self.charge(max(10, n // 250))
        if d < s + n and s < d + n:
            raise Fault("memcpy overlap")
        self.write(d, self.read(s, n))

    def sys_sol_memset(self, d, c, n, *_):
        self.charge(max(10, n // 250))
        self.write(d, bytes([c & 0xff]) * n)

    def sys_sol_memcmp(self, a, b, n, out, *_):
        self.charge(max(10, n // 250))
        x, y = self.read(a, n), self.read(b, n)
        r = 0
        for i in range(n):
            if x[i] != y[i]:
                r = x[i] - y[i]
                break
        self.wr(out, 4, r)

    def pda(self, seeds, program):
        h = hashlib.sha256(b"".join(seeds) + program + b"ProgramDerivedAddress").digest()
        return None if on_curve(h) else h

    def sys_sol_create_program_address(self, seeds, n, prog, out, *_):
        self.charge(1500)
        k = self.pda(self.slices(seeds, n), self.read(prog, 32))
        if k is None:
            return 1
        self.write(out, k)
        return 0

    def sys_sol_try_find_program_address(self, seeds, n, prog, out, bump_out):
        self.charge(1500)
        base = self.slices(seeds, n)
        program = self.read(prog, 32)
        for bump in range(255, -1, -1):
            k = self.pda(base + [bytes([bump])], program)
            if k is not None:
                self.write(out, k)
                self.write(bump_out, bytes([bump]))
                return 0
            self.charge(1500)
        return 1

    def sys_abort(self, *_):
        raise Fault("abort")

    def sys_sol_panic(self, a, n, line, col, *_):
        raise Fault(f"panic {self.read(a, n)!r} {line}:{col}")

    def sys_sol_invoke_signed_c(self, ix, infos, ninfo, seeds, nseeds):
        self.charge(946)
        prog_a, metas_a, nmeta, data_a, dlen = struct.unpack("<QQQQQ", self.read(ix, 40))
        if ix % 8 or infos % 8 or metas_a % 8:
            raise Fault("misaligned cpi struct")
        if infos + 56 * ninfo > MM_INPUT:
            raise Fault("account infos must be below input region")
        prog = self.read(prog_a, 32)
        data = self.read(data_a, dlen)
        self.charge((dlen + 34 * nmeta) // 250 + ninfo * 80 // 250)
        signers = set()
        for seedset in self.slices_raw(seeds, nseeds):
            k = self.pda(self.slices(*seedset), self.program)
            if k is None:
                raise Fault("bad signer seeds")
            signers.add(k)
        info_keys = {}
        for i in range(ninfo):
            ka, la, dl, da, oa, _, s, w, x = struct.unpack("<QQQQQQBBB", self.read(infos + 56 * i, 51))
            key = self.read(ka, 32)
            spot = self.spot_of(key)
            if ka != MM_INPUT + spot + 8 or la != MM_INPUT + spot + 72 or oa != MM_INPUT + spot + 40 or da != MM_INPUT + spot + 88:
                raise Fault("account info pointer mismatch")
            info_keys.setdefault(key, (s, w))
        metas = []
        for i in range(nmeta):
            pa, w, s = struct.unpack("<QBB", self.read(metas_a + 16 * i, 10))
            if w > 1 or s > 1:
                raise Fault("bad meta flag")
            key = self.read(pa, 32)
            if key not in info_keys and key != prog:
                raise Fault("cpi references unknown account")
            acc = self.accounts[self.index_of(key)]
            if s and not acc.get("signer") and key not in signers:
                raise Fault("privilege escalation: signer")
            if w and not acc.get("writable"):
                raise Fault("privilege escalation: writable")
            metas.append((key, bool(s), bool(w)))
        self.cpis.append((prog, metas, data))
        if self.cpi_handler:
            deserialize(self.input, self.accounts, self.spots)
            self.cpi_handler(prog, metas, data, self.accounts)
            self.writeback()
        return 0

    def writeback(self):
        done = set()
        for a, s in zip(self.accounts, self.spots):
            if s in done:
                continue
            done.add(s)
            data = bytes(a.get("data", b""))
            self.input[s + 40:s + 72] = a.get("owner", bytes(32))
            self.input[s + 72:s + 88] = struct.pack("<QQ", a.get("lamports", 0), len(data))
            self.input[s + 88:s + 88 + len(data)] = data

    def slices_raw(self, addr, n):
        return [struct.unpack("<QQ", self.read(addr + 16 * i, 16)) for i in range(n)]

    def index_of(self, key):
        for i, a in enumerate(self.accounts):
            if a["key"] == key:
                return i
        raise Fault("unknown account")

    def spot_of(self, key):
        return self.spots[self.index_of(key)]

    def run(self):
        reg = self.reg
        text = self.text
        n_insn = len(text) // 8
        while True:
            if not 0 <= self.pc < n_insn:
                raise Fault(f"pc out of range {self.pc}")
            opc, regs, off, imm = struct.unpack_from("<BBhi", text, 8 * self.pc)
            dst, src = regs & 15, regs >> 4
            self.pc += 1
            self.charge(1)
            cls = opc & 7
            if opc == 0x18:
                hi = struct.unpack_from("<i", text, 8 * self.pc + 4)[0]
                reg[dst] = ((imm & 0xffffffff) | ((hi & 0xffffffff) << 32)) & U64
                self.pc += 1
            elif cls in (4, 7):
                op = opc & 0xf0
                x = reg[src] if opc & 8 else (imm & U64)
                if cls == 7:
                    a = reg[dst]
                    if op == 0x00: r = a + x
                    elif op == 0x10: r = a - x
                    elif op == 0x20: r = a * x
                    elif op == 0x30:
                        if x == 0: raise Fault("divide by zero")
                        r = a // x
                    elif op == 0x40: r = a | x
                    elif op == 0x50: r = a & x
                    elif op == 0x60: r = a << (x & 63)
                    elif op == 0x70: r = a >> (x & 63)
                    elif op == 0x80: r = -a
                    elif op == 0x90:
                        if x == 0: raise Fault("divide by zero")
                        r = a % x
                    elif op == 0xa0: r = a ^ x
                    elif op == 0xb0: r = x
                    elif op == 0xc0: r = to_s64(a) >> (x & 63)
                    else: raise Fault(f"bad opcode {opc:#x}")
                    if dst == 10: raise Fault("write r10")
                    reg[dst] = r & U64
                else:
                    a = reg[dst] & 0xffffffff
                    x &= 0xffffffff
                    if op == 0x00: r = sext32(a + x) & U64
                    elif op == 0x10: r = sext32(a - x) & U64
                    elif op == 0x20: r = sext32(a * x) & U64
                    elif op == 0x30:
                        if x == 0: raise Fault("divide by zero")
                        r = a // x
                    elif op == 0x40: r = a | x
                    elif op == 0x50: r = a & x
                    elif op == 0x60: r = (a << (x & 31)) & 0xffffffff
                    elif op == 0x70: r = a >> (x & 31)
                    elif op == 0x80: r = (-a) & 0xffffffff
                    elif op == 0x90:
                        if x == 0: raise Fault("divide by zero")
                        r = a % x
                    elif op == 0xa0: r = a ^ x
                    elif op == 0xb0: r = x
                    elif op == 0xc0: r = (sext32(a) >> (x & 31)) & 0xffffffff
                    else: raise Fault(f"bad opcode {opc:#x}")
                    if dst == 10: raise Fault("write r10")
                    reg[dst] = r
            elif cls == 1:
                size = {0x61: 4, 0x69: 2, 0x71: 1, 0x79: 8}[opc]
                reg[dst] = self.rd((reg[src] + off) & U64, size)
            elif cls == 2:
                size = {0x62: 4, 0x6a: 2, 0x72: 1, 0x7a: 8}[opc]
                self.wr((reg[dst] + off) & U64, size, imm & U64)
            elif cls == 3:
                size = {0x63: 4, 0x6b: 2, 0x73: 1, 0x7b: 8}[opc]
                self.wr((reg[dst] + off) & U64, size, reg[src])
            elif cls in (5, 6):
                op = opc & 0xf0
                if cls == 5 and op == 0x80:
                    if opc == 0x85 and src == 0:
                        fn = self.sys.get(imm & 0xffffffff)
                        if fn is None:
                            raise Fault(f"unknown syscall {imm & 0xffffffff:#x}")
                        self.charge(0)
                        r = fn(reg[1], reg[2], reg[3], reg[4], reg[5])
                        reg[0] = r or 0
                    else:
                        if opc == 0x85:
                            target = self.pc + imm
                        else:
                            target = (reg[dst] - MM_TEXT) // 8
                        if len(self.frames) + 1 >= MAX_DEPTH:
                            raise Fault("call depth exceeded")
                        self.frames.append((reg[6:10], reg[10], self.pc))
                        reg[10] += FRAME
                        self.pc = target
                    continue
                if cls == 5 and op == 0x90:
                    if not self.frames:
                        deserialize(self.input, self.accounts, self.spots)
                        return reg[0]
                    saved, fp, ret = self.frames.pop()
                    reg[6:10] = saved
                    reg[10] = fp
                    self.pc = ret
                    continue
                if cls == 5 and op == 0x00:
                    self.pc += off
                    continue
                x = reg[src] if opc & 8 else (imm & U64)
                a = reg[dst]
                if cls == 6:
                    a &= 0xffffffff
                    x &= 0xffffffff
                    sa, sx = sext32(a), sext32(x)
                else:
                    sa, sx = to_s64(a), to_s64(x)
                take = {0x10: a == x, 0x20: a > x, 0x30: a >= x, 0x40: (a & x) != 0, 0x50: a != x,
                        0x60: sa > sx, 0x70: sa >= sx, 0xa0: a < x, 0xb0: a <= x, 0xc0: sa < sx, 0xd0: sa <= sx}.get(op)
                if take is None:
                    raise Fault(f"bad opcode {opc:#x}")
                if take:
                    self.pc += off
            else:
                raise Fault(f"bad opcode {opc:#x}")

    def used(self):
        return self.cu_limit - self.cu
