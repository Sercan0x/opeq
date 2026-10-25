import hashlib
import struct
import zlib

NO_INDEX = 0xffffffff

ACC_PUBLIC = 0x1
ACC_PRIVATE = 0x2
ACC_STATIC = 0x8
ACC_FINAL = 0x10
ACC_CONSTRUCTOR = 0x10000

INVOKE = {"invoke-virtual": 0x6e, "invoke-super": 0x6f, "invoke-direct": 0x70, "invoke-static": 0x71, "invoke-interface": 0x72}
MOVE_RESULT = {"move-result": 0x0a, "move-result-object": 0x0c, "move-exception": 0x0d}
RETURN = {"return": 0x0f, "return-object": 0x11}
IF_Z = {"if-eqz": 0x38, "if-nez": 0x39}
FIELD = {"iget-object": 0x54, "iput-object": 0x5b}


def uleb(n):
    out = bytearray()
    while True:
        b = n & 0x7f
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def sleb(n):
    out = bytearray()
    while True:
        b = n & 0x7f
        n >>= 7
        if (n == 0 and not b & 0x40) or (n == -1 and b & 0x40):
            out.append(b)
            return bytes(out)
        out.append(b | 0x80)


def mutf8(s):
    out = bytearray()
    for ch in s:
        c = ord(ch)
        if c == 0 or c > 0xffff:
            raise ValueError("only BMP characters without NUL are supported")
        if c < 0x80:
            out.append(c)
        elif c < 0x800:
            out += bytes([0xc0 | c >> 6, 0x80 | c & 0x3f])
        else:
            out += bytes([0xe0 | c >> 12, 0x80 | (c >> 6) & 0x3f, 0x80 | c & 0x3f])
    return bytes(out)


def shorty(desc):
    return "L" if desc[0] in "L[" else desc


def align(buf, n):
    while len(buf) % n:
        buf.append(0)


class Method:
    def __init__(self, cls, name, ret, params=()):
        self.cls, self.name, self.ret, self.params = cls, name, ret, tuple(params)

    def key(self):
        return (self.cls, self.name, self.ret, self.params)


class Field:
    def __init__(self, cls, name, type_):
        self.cls, self.name, self.type = cls, name, type_

    def key(self):
        return (self.cls, self.name, self.type)


class Code:
    def __init__(self, registers, ins, ops):
        self.registers, self.ins, self.ops = registers, ins, ops


class Class:
    def __init__(self, name, superclass, access=ACC_PUBLIC, interfaces=()):
        self.name, self.superclass, self.access, self.interfaces = name, superclass, access, tuple(interfaces)
        self.fields = []
        self.direct = []
        self.virtual = []

    def field(self, name, type_, access=ACC_PRIVATE):
        f = Field(self.name, name, type_)
        self.fields.append((f, access))
        return f

    def method(self, name, ret, params, access, code):
        m = Method(self.name, name, ret, params)
        direct = name == "<init>" or access & (ACC_STATIC | ACC_PRIVATE)
        (self.direct if direct else self.virtual).append((m, access, code))
        return m


class Dex:
    def __init__(self):
        self.classes = []

    def add(self, cls):
        self.classes.append(cls)
        return cls

    def collect(self):
        strings, types, protos, methods, fields = set(), set(), set(), set(), set()

        def t(desc):
            types.add(desc)
            strings.add(desc)

        def proto(ret, params):
            t(ret)
            for p in params:
                t(p)
            strings.add(shorty(ret) + "".join(shorty(p) for p in params))
            protos.add((ret, tuple(params)))

        def meth(m):
            t(m.cls)
            strings.add(m.name)
            proto(m.ret, m.params)
            methods.add(m.key())

        def fld(f):
            t(f.cls)
            t(f.type)
            strings.add(f.name)
            fields.add(f.key())

        for c in self.classes:
            t(c.name)
            t(c.superclass)
            for i in c.interfaces:
                t(i)
            for f, _ in c.fields:
                fld(f)
            for m, _, code in c.direct + c.virtual:
                meth(m)
                for op in code.ops:
                    for arg in op[1:]:
                        if isinstance(arg, Method):
                            meth(arg)
                        elif isinstance(arg, Field):
                            fld(arg)
                    if op[0] == "const-string":
                        strings.add(op[2])
                    elif op[0] in ("new-instance", "check-cast"):
                        t(op[2])
        return strings, types, protos, methods, fields

    def build(self):
        strings, types, protos, methods, fields = self.collect()
        strings = sorted(strings, key=lambda s: [ord(c) for c in s])
        sidx = {s: i for i, s in enumerate(strings)}
        types = sorted(types, key=lambda d: sidx[d])
        tidx = {d: i for i, d in enumerate(types)}
        protos = sorted(protos, key=lambda p: (tidx[p[0]], [tidx[x] for x in p[1]]))
        pidx = {p: i for i, p in enumerate(protos)}
        fields = sorted(fields, key=lambda f: (tidx[f[0]], sidx[f[1]], tidx[f[2]]))
        fidx = {f: i for i, f in enumerate(fields)}
        methods = sorted(methods, key=lambda m: (tidx[m[0]], sidx[m[1]], pidx[(m[2], m[3])]))
        midx = {m: i for i, m in enumerate(methods)}

        defined = {c.name for c in self.classes}
        order = []
        while len(order) < len(self.classes):
            for c in self.classes:
                if c in order:
                    continue
                deps = {c.superclass, *c.interfaces} & defined
                if all(any(o.name == d for o in order) for d in deps):
                    order.append(c)

        n_str, n_type, n_proto, n_field, n_meth, n_cls = (
            len(strings), len(types), len(protos), len(fields), len(methods), len(order))
        off = 0x70
        string_ids_off = off
        off += 4 * n_str
        type_ids_off = off
        off += 4 * n_type
        proto_ids_off = off
        off += 12 * n_proto
        field_ids_off = off if n_field else 0
        off += 8 * n_field
        method_ids_off = off
        off += 8 * n_meth
        class_defs_off = off
        off += 32 * n_cls
        data_off = off

        data = bytearray()
        sections = []

        def here():
            return data_off + len(data)

        code_offs = {}
        code_start = None
        n_code = 0
        for c in order:
            for m, access, code in c.direct + c.virtual:
                align(data, 4)
                if code_start is None:
                    code_start = here()
                code_offs[m.key()] = here()
                data += self.encode_code(code, m, sidx, tidx, midx, fidx)
                n_code += 1
        if n_code:
            sections.append((0x2001, n_code, code_start))

        type_lists = {}
        tl_start = None
        wanted = []
        for p in protos:
            if p[1] and p[1] not in wanted:
                wanted.append(p[1])
        for c in order:
            if c.interfaces and c.interfaces not in wanted:
                wanted.append(c.interfaces)
        for lst in wanted:
            align(data, 4)
            if tl_start is None:
                tl_start = here()
            type_lists[lst] = here()
            data += struct.pack("<I", len(lst)) + b"".join(struct.pack("<H", tidx[x]) for x in lst)
        if wanted:
            sections.append((0x1001, len(wanted), tl_start))

        str_offs = []
        sd_start = here()
        for s in strings:
            str_offs.append(here())
            data += uleb(len(s)) + mutf8(s) + b"\0"
        sections.append((0x2002, n_str, sd_start))

        cd_offs = {}
        cd_start = here()
        for c in order:
            cd_offs[c.name] = here()
            item = bytearray()
            stat = [(f, a) for f, a in c.fields if a & ACC_STATIC]
            inst = [(f, a) for f, a in c.fields if not a & ACC_STATIC]
            item += uleb(len(stat)) + uleb(len(inst)) + uleb(len(c.direct)) + uleb(len(c.virtual))
            for group in (stat, inst):
                prev = 0
                for f, a in sorted(group, key=lambda x: fidx[x[0].key()]):
                    i = fidx[f.key()]
                    item += uleb(i - prev) + uleb(a)
                    prev = i
            for group in (c.direct, c.virtual):
                prev = 0
                for m, a, _ in sorted(group, key=lambda x: midx[x[0].key()]):
                    i = midx[m.key()]
                    item += uleb(i - prev) + uleb(a) + uleb(code_offs[m.key()])
                    prev = i
            data += item
        sections.append((0x2000, n_cls, cd_start))

        align(data, 4)
        map_off = here()
        items = [(0x0000, 1, 0), (0x0001, n_str, string_ids_off), (0x0002, n_type, type_ids_off),
                 (0x0003, n_proto, proto_ids_off)]
        if n_field:
            items.append((0x0004, n_field, field_ids_off))
        items += [(0x0005, n_meth, method_ids_off), (0x0006, n_cls, class_defs_off)]
        items += sections
        items.append((0x1000, 1, map_off))
        data += struct.pack("<I", len(items))
        for typ, size, o in items:
            data += struct.pack("<HHII", typ, 0, size, o)
        align(data, 4)

        out = bytearray(0x70)
        for o in str_offs:
            out += struct.pack("<I", o)
        for d in types:
            out += struct.pack("<I", sidx[d])
        for ret, params in protos:
            out += struct.pack("<III", sidx[shorty(ret) + "".join(shorty(p) for p in params)],
                               tidx[ret], type_lists[params] if params else 0)
        for cls, name, typ in fields:
            out += struct.pack("<HHI", tidx[cls], tidx[typ], sidx[name])
        for cls, name, ret, params in methods:
            out += struct.pack("<HHI", tidx[cls], pidx[(ret, params)], sidx[name])
        for c in order:
            out += struct.pack("<IIIIIIII", tidx[c.name], c.access, tidx[c.superclass],
                               type_lists[c.interfaces] if c.interfaces else 0, NO_INDEX, 0, cd_offs[c.name], 0)
        assert len(out) == data_off
        out += data

        struct.pack_into("<8s", out, 0, b"dex\n035\0")
        struct.pack_into("<IIIIII", out, 32, len(out), 0x70, 0x12345678, 0, 0, map_off)
        struct.pack_into("<IIIIIIIIIIIIII", out, 56,
                         n_str, string_ids_off, n_type, type_ids_off, n_proto, proto_ids_off,
                         n_field, field_ids_off, n_meth, method_ids_off, n_cls, class_defs_off,
                         len(out) - data_off, data_off)
        out[12:32] = hashlib.sha1(out[32:]).digest()
        struct.pack_into("<I", out, 8, zlib.adler32(bytes(out[12:])))
        return bytes(out)

    def encode_code(self, code, m, sidx, tidx, midx, fidx):
        ins_size = code.ins
        need = len(m.params) + (0 if self.is_static(m) else 1)
        if any(p in ("J", "D") for p in m.params):
            raise ValueError("wide parameters are not supported")
        if ins_size != need:
            raise ValueError(f"{m.cls}.{m.name}: ins {ins_size} but the signature needs {need}")
        units = []
        labels = {}
        fixups = []
        outs = 0
        tries = []
        pending_try = {}

        def reg4(r):
            if not 0 <= r < 16:
                raise ValueError(f"register v{r} does not fit in 4 bits")
            return r

        def reg8(r):
            if not 0 <= r < 256:
                raise ValueError(f"register v{r} does not fit in 8 bits")
            return r

        for op in code.ops:
            name = op[0]
            if name == "label":
                labels[op[1]] = len(units)
            elif name == "try-start":
                pending_try[op[1]] = len(units)
            elif name == "try-end":
                tries.append((pending_try.pop(op[1]), len(units), op[2]))
            elif name in INVOKE:
                regs, meth = op[1], op[2]
                if len(regs) > 5:
                    raise ValueError("at most 5 registers per invoke")
                outs = max(outs, len(regs))
                r = [reg4(x) for x in regs] + [0] * (5 - len(regs))
                g = r[4]
                units += [INVOKE[name] | (len(regs) << 12) | (g << 8), midx[meth.key()],
                          r[0] | r[1] << 4 | r[2] << 8 | r[3] << 12]
            elif name in MOVE_RESULT:
                units.append(MOVE_RESULT[name] | reg8(op[1]) << 8)
            elif name == "return-void":
                units.append(0x0e)
            elif name in RETURN:
                units.append(RETURN[name] | reg8(op[1]) << 8)
            elif name == "const/4":
                v = op[2]
                if not -8 <= v <= 7:
                    raise ValueError("const/4 value out of range")
                units.append(0x12 | reg4(op[1]) << 8 | (v & 0xf) << 12)
            elif name == "const/16":
                v = op[2]
                if not -0x8000 <= v <= 0x7fff:
                    raise ValueError("const/16 value out of range")
                units += [0x13 | reg8(op[1]) << 8, v & 0xffff]
            elif name == "const":
                v = op[2] & 0xffffffff
                units += [0x14 | reg8(op[1]) << 8, v & 0xffff, v >> 16]
            elif name == "const-string":
                i = sidx[op[2]]
                if i > 0xffff:
                    raise ValueError("string index too large for const-string")
                units += [0x1a | reg8(op[1]) << 8, i]
            elif name == "new-instance":
                units += [0x22 | reg8(op[1]) << 8, tidx[op[2]]]
            elif name == "check-cast":
                units += [0x1f | reg8(op[1]) << 8, tidx[op[2]]]
            elif name in IF_Z:
                fixups.append((len(units), op[2], "21t"))
                units += [IF_Z[name] | reg8(op[1]) << 8, 0]
            elif name == "goto":
                fixups.append((len(units), op[1], "10t"))
                units.append(0x28)
            elif name in FIELD:
                units += [FIELD[name] | reg4(op[1]) << 8 | reg4(op[2]) << 12, fidx[op[3].key()]]
            else:
                raise ValueError(f"unknown op {name}")
        for at, label, fmt in fixups:
            delta = labels[label] - at
            if fmt == "21t":
                if not -0x8000 <= delta <= 0x7fff or delta == 0:
                    raise ValueError("branch out of range")
                units[at + 1] = delta & 0xffff
            else:
                if not -0x80 <= delta <= 0x7f or delta == 0:
                    raise ValueError("goto out of range")
                units[at] |= (delta & 0xff) << 8
        if code.registers < ins_size:
            raise ValueError("fewer registers than ins")
        out = bytearray(struct.pack("<HHHHII", code.registers, ins_size, outs, len(tries), 0, len(units)))
        for u in units:
            out += struct.pack("<H", u)
        if tries:
            if len(units) % 2:
                out += b"\0\0"
            handlers = bytearray(uleb(len(tries)))
            hoffs = []
            for _, _, handler in tries:
                hoffs.append(len(handlers))
                handlers += sleb(0) + uleb(labels[handler])
            for (start, end, _), ho in zip(tries, hoffs):
                out += struct.pack("<IHH", start, end - start, ho)
            out += handlers
        return bytes(out)

    def is_static(self, m):
        for c in self.classes:
            for mm, access, _ in c.direct + c.virtual:
                if mm.key() == m.key():
                    return bool(access & ACC_STATIC)
        return False
