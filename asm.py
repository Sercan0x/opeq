import struct

MM_BYTECODE = 1 << 32


class Reg(int):
    def __repr__(self):
        return f"r{int(self)}"


r0, r1, r2, r3, r4, r5, r6, r7, r8, r9, r10 = (Reg(i) for i in range(11))

SIZE = {1: 0x10, 2: 0x08, 4: 0x00, 8: 0x18}

ALU = {"add": 0x00, "sub": 0x10, "mul": 0x20, "div": 0x30, "or": 0x40, "and": 0x50,
       "lsh": 0x60, "rsh": 0x70, "mod": 0x90, "xor": 0xa0, "mov": 0xb0, "arsh": 0xc0}

JMP = {"jeq": 0x10, "jgt": 0x20, "jge": 0x30, "jset": 0x40, "jne": 0x50, "jsgt": 0x60,
       "jsge": 0x70, "jlt": 0xa0, "jle": 0xb0, "jslt": 0xc0, "jsle": 0xd0}


def murmur3_32(data, seed=0):
    c1, c2 = 0xcc9e2d51, 0x1b873593
    h = seed
    n = len(data)
    for i in range(n // 4):
        k = int.from_bytes(data[4 * i:4 * i + 4], "little")
        k = (k * c1) & 0xffffffff
        k = ((k << 15) | (k >> 17)) & 0xffffffff
        k = (k * c2) & 0xffffffff
        h ^= k
        h = ((h << 13) | (h >> 19)) & 0xffffffff
        h = (h * 5 + 0xe6546b64) & 0xffffffff
    tail = data[4 * (n // 4):]
    k = 0
    if len(tail) >= 3:
        k ^= tail[2] << 16
    if len(tail) >= 2:
        k ^= tail[1] << 8
    if len(tail) >= 1:
        k ^= tail[0]
        k = (k * c1) & 0xffffffff
        k = ((k << 15) | (k >> 17)) & 0xffffffff
        k = (k * c2) & 0xffffffff
        h ^= k
    h ^= n
    h ^= h >> 16
    h = (h * 0x85ebca6b) & 0xffffffff
    h ^= h >> 13
    h = (h * 0xc2b2ae35) & 0xffffffff
    h ^= h >> 16
    return h


def syscall_hash(name):
    return murmur3_32(name.encode())


def insn(opc, dst=0, src=0, off=0, imm=0):
    return struct.pack("<BBhi", opc, (src << 4) | dst, off, imm)


def s32(v):
    v &= 0xffffffff
    return v - (1 << 32) if v & 0x80000000 else v


class Asm:
    def __init__(self):
        self.code = []
        self.labels = {}
        self.ro = bytearray(8)
        self.ro_labels = {}

    def here(self):
        return len(self.code)

    def label(self, name):
        if name in self.labels:
            raise ValueError(f"duplicate label {name}")
        self.labels[name] = self.here()

    def data(self, name, blob, align=8):
        while len(self.ro) % align:
            self.ro.append(0)
        self.ro_labels[name] = len(self.ro)
        self.ro += blob
        return self.ro_labels[name]

    def emit(self, opc, dst=0, src=0, off=0, imm=0, fix=None):
        self.code.append([opc, int(dst), int(src), off, imm, fix])

    def _alu(self, cls, op, dst, x):
        if isinstance(x, Reg):
            self.emit(cls | 0x08 | ALU[op], dst, x)
        else:
            if not -(1 << 31) <= x < (1 << 31):
                raise ValueError(f"imm out of range {x} (use lddw for values at or above 2**31)")
            self.emit(cls | ALU[op], dst, 0, 0, s32(x))

    def __getattr__(self, name):
        name = name.rstrip("_")
        if name.endswith("32") and name[:-2] in ALU:
            return lambda dst, x: self._alu(0x04, name[:-2], dst, x)
        if name in ALU:
            return lambda dst, x: self._alu(0x07, name, dst, x)
        if name in JMP:
            return lambda dst, x, target: self._jmp(0x05, name, dst, x, target)
        if name.endswith("32") and name[:-2] in JMP:
            return lambda dst, x, target: self._jmp(0x06, name[:-2], dst, x, target)
        raise AttributeError(name)

    def _jmp(self, cls, op, dst, x, target):
        if isinstance(x, Reg):
            self.emit(cls | 0x08 | JMP[op], dst, x, fix=("jmp", target))
        else:
            self.emit(cls | JMP[op], dst, 0, 0, s32(x), fix=("jmp", target))

    def neg(self, dst):
        self.emit(0x87, dst)

    def ja(self, target):
        self.emit(0x05, fix=("jmp", target))

    def lddw(self, dst, value):
        if isinstance(value, str):
            self.emit(0x18, dst, fix=("ro", value))
        else:
            self.emit(0x18, dst, 0, 0, s32(value & 0xffffffff))
        self.emit(0x00, 0, 0, 0, s32((value >> 32) & 0xffffffff) if not isinstance(value, str) else 0)

    def ldx(self, size, dst, src, off):
        self.emit(0x61 | SIZE[size], dst, src, off)

    def st(self, size, dst, off, imm):
        self.emit(0x62 | SIZE[size], dst, 0, off, s32(imm))

    def stx(self, size, dst, off, src):
        self.emit(0x63 | SIZE[size], dst, src, off)

    def call(self, target):
        self.emit(0x85, 0, 1, fix=("call", target))

    def syscall(self, name):
        self.emit(0x85, 0, 0, 0, s32(syscall_hash(name)))

    def callx(self, reg):
        self.emit(0x8d, reg)

    def exit(self):
        self.emit(0x95)

    def ret_imm(self, code):
        self.mov(r0, code)
        self.exit()

    def text(self):
        out = bytearray()
        for pc, (opc, dst, src, off, imm, fix) in enumerate(self.code):
            if fix:
                kind, target = fix
                if kind == "ro":
                    imm = s32(self.ro_labels[target])
                else:
                    if target not in self.labels:
                        raise ValueError(f"unknown label {target}")
                    delta = self.labels[target] - pc - 1
                    if kind == "jmp":
                        if not -(1 << 15) <= delta < (1 << 15):
                            raise ValueError(f"jump too far to {target}")
                        off = delta
                    else:
                        imm = delta
            out += insn(opc, dst, src, off, imm)
        return bytes(out)

    def rodata(self):
        if not self.ro_labels:
            return b""
        ro = bytearray(self.ro)
        while len(ro) % 8:
            ro.append(0)
        return bytes(ro)

    def elf(self, entry="entrypoint"):
        return build_elf(self.rodata(), self.text(), self.labels[entry])


def build_elf(rodata, text, entry_pc):
    phnum = 2 if rodata else 1
    seg_off = 64 + 56 * phnum
    ehdr = b"\x7fELF" + bytes([2, 1, 1, 0]) + bytes(8)
    ehdr += struct.pack("<HHIQQQIHHHHHH", 3, 247, 1, MM_BYTECODE + 8 * entry_pc, 64, 0, 3, 64, 56, phnum, 0, 0, 0)
    phdrs = b""
    off = seg_off
    if rodata:
        phdrs += struct.pack("<IIQQQQQQ", 1, 4, off, 0, 0, len(rodata), len(rodata), 0)
        off += len(rodata)
    phdrs += struct.pack("<IIQQQQQQ", 1, 1, off, MM_BYTECODE, MM_BYTECODE, len(text), len(text), 0)
    return ehdr + phdrs + rodata + text
