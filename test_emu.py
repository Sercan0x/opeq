import os
import random
import struct
import sys

import emu
import program
import protocol as P
import refmodel as R
import wots

SYSTEM = bytes(32)


def system_handler(prog, metas, data, accounts):
    if prog != SYSTEM:
        return
    by_key = {a["key"]: a for a in accounts}
    tag, = struct.unpack_from("<I", data, 0)
    if tag == 2:
        amt, = struct.unpack_from("<Q", data, 4)
        src, dst = by_key[metas[0][0]], by_key[metas[1][0]]
        if src["lamports"] < amt:
            raise emu.Fault("insufficient lamports")
        src["lamports"] -= amt
        dst["lamports"] += amt
    elif tag == 8:
        space, = struct.unpack_from("<Q", data, 4)
        by_key[metas[0][0]]["data"] = bytearray(space)
    elif tag == 1:
        by_key[metas[0][0]]["owner"] = bytes(data[4:36])
    else:
        raise emu.Fault(f"unsupported system ix {tag}")


class World:
    def __init__(self, elf, key=None):
        self.elf = elf
        self.prog = os.urandom(32)
        self.key = key or wots.TreeKey.generate()
        self.aid = P.account_id(self.key.pub_seed, self.key.root)
        self.state_key, _ = P.state_pda(self.aid, self.prog)
        self.wallet_key, _ = P.wallet_pda(self.aid, self.prog)
        self.payer = {"key": os.urandom(32), "signer": True, "writable": True, "lamports": 10**10, "owner": SYSTEM, "data": bytearray()}
        self.state = {"key": self.state_key, "writable": True, "lamports": 0, "owner": SYSTEM, "data": bytearray()}
        self.wallet = {"key": self.wallet_key, "writable": True, "lamports": 0, "owner": SYSTEM, "data": bytearray()}
        self.system = {"key": SYSTEM, "executable": True, "owner": os.urandom(32), "data": bytearray()}
        self.bob = {"key": os.urandom(32), "writable": True, "lamports": 0, "owner": SYSTEM, "data": bytearray()}
        self.slot = 1800

    def run(self, accounts, data):
        vm = emu.Vm(self.elf, accounts, data, self.prog, slot=self.slot, cpi_handler=system_handler)
        rc = vm.run()
        return rc, vm

    def init(self, lamports=1_500_000):
        accs = [self.payer, self.state, self.wallet, self.system]
        return self.run(accs, P.build_init(self.key.pub_seed, self.key.root, lamports))

    def exec_accounts(self):
        return [self.state, self.wallet, self.system, self.bob]

    def transfer_inner(self, amount, to=None):
        to = to or self.bob["key"]
        return [(SYSTEM, [(self.wallet_key, True, True), (to, False, True)], struct.pack("<IQ", 2, amount))]

    def signed_exec(self, leaf, expiry, inner, key=None, sent_inner=None, tries=1, r=None):
        st = P.unpack_state(bytes(self.state["data"]))
        r = r or os.urandom(P.R_LEN)
        salt, d, _ = P.grind(P.exec_hasher(self.prog, self.aid, st["epoch"], leaf, expiry, inner, r=r), tries)
        sig, path = (key or self.key).sign(leaf, d)
        keys = [a["key"] for a in self.exec_accounts()]
        return P.build_exec(leaf, expiry, salt, r, sig, path, sent_inner or inner, keys)

    def signed_rekey(self, leaf, new, expiry=2000, key=None, tries=1):
        st = P.unpack_state(bytes(self.state["data"]))
        r = os.urandom(P.R_LEN)
        salt, d, _ = P.grind(P.rekey_hasher(self.prog, self.aid, st["epoch"], leaf, expiry, new.pub_seed, new.root, r=r), tries)
        sig, path = (key or self.key).sign(leaf, d)
        return P.build_rekey(leaf, expiry, salt, r, sig, path, new.pub_seed, new.root)


def snapshot(accounts):
    return [{k: (bytearray(v) if isinstance(v, bytearray) else v) for k, v in a.items()} for a in accounts]


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        check.failed += 1


check.failed = 0


def main():
    elf = program.build().elf()
    w = World(elf)

    rc, vm = w.init()
    check(f"init rc={rc} cu={vm.used()}", rc == 0)
    st = P.unpack_state(bytes(w.state["data"]))
    check("init state contents", st["root"] == w.key.root and st["pub_seed"] == w.key.pub_seed and st["id"] == w.aid
          and st["sbump"] == P.state_pda(w.aid, w.prog)[1] and st["wbump"] == P.wallet_pda(w.aid, w.prog)[1]
          and w.state["owner"] == w.prog and w.state["lamports"] == 1_500_000)
    rc, _ = w.init()
    check(f"double init rejected rc={rc}", rc == 19)

    w.wallet["lamports"] = 5_000_000
    inner = w.transfer_inner(1_234_567)
    rc, vm = w.run(w.exec_accounts(), w.signed_exec(0, 2000, inner))
    check(f"exec transfer rc={rc} cu={vm.used()}", rc == 0 and w.bob["lamports"] == 1_234_567 and w.wallet["lamports"] == 5_000_000 - 1_234_567)
    check("next advanced", P.unpack_state(bytes(w.state["data"]))["next"] == 1)
    rc, _ = w.run(w.exec_accounts(), w.signed_exec(0, 2000, inner))
    check(f"replay rejected rc={rc}", rc == 7)
    rc, _ = w.run(w.exec_accounts(), w.signed_exec(1, 999, inner))
    check(f"expired rejected rc={rc}", rc == 6)
    rc, _ = w.run(w.exec_accounts(), w.signed_exec(1, 2000, inner, sent_inner=w.transfer_inner(4_000_000)))
    check(f"tampered amount rejected rc={rc}", rc == 13)
    other = wots.TreeKey.generate()
    rc, _ = w.run(w.exec_accounts(), w.signed_exec(1, 2000, inner, key=other))
    check(f"wrong key rejected rc={rc}", rc == 13)
    forged = bytearray(w.signed_exec(1, 2000, inner))
    forged[1:5] = struct.pack("<I", 1024)
    rc, _ = w.run(w.exec_accounts(), bytes(forged))
    check(f"leaf out of range rc={rc}", rc == 8)

    cus, gcus = [], []
    for leaf in range(5, 25):
        rc, vm = w.run(w.exec_accounts(), w.signed_exec(leaf, 2000, w.transfer_inner(1000)))
        cus.append(vm.used())
        if rc != 0:
            check(f"exec leaf {leaf} rc={rc}", False)
    check(f"20 unground execs ok, cu min {min(cus)} avg {sum(cus) // len(cus)} max {max(cus)}", w.bob["lamports"] == 1_234_567 + 20 * 1000)
    for leaf in range(25, 35):
        rc, vm = w.run(w.exec_accounts(), w.signed_exec(leaf, 2000, w.transfer_inner(1000), tries=P.GRIND_TRIES))
        gcus.append(vm.used())
        if rc != 0:
            check(f"ground exec leaf {leaf} rc={rc}", False)
    check(f"10 ground execs ok, cu min {min(gcus)} avg {sum(gcus) // len(gcus)} max {max(gcus)}", w.bob["lamports"] == 1_234_567 + 30 * 1000)

    new = wots.TreeKey.generate()
    st = P.unpack_state(bytes(w.state["data"]))
    leaf = st["next"]
    rc, vm = w.run(w.exec_accounts(), w.signed_rekey(leaf, new, tries=P.GRIND_TRIES))
    st = P.unpack_state(bytes(w.state["data"]))
    check(f"rekey rc={rc} cu={vm.used()}", rc == 0 and st["root"] == new.root and st["epoch"] == 1 and st["next"] == 0)
    old_key = w.key
    w.key = new
    rc, _ = w.run(w.exec_accounts(), w.signed_exec(0, 2000, w.transfer_inner(7)))
    check(f"exec with new tree rc={rc}", rc == 0)
    rc, _ = w.run(w.exec_accounts(), w.signed_exec(3, 2000, w.transfer_inner(7), key=old_key))
    check(f"old tree rejected after rekey rc={rc}", rc == 13)

    data = bytearray(w.signed_exec(1, 2000, w.transfer_inner(7)))
    data[P.R_OFF] ^= 1
    rc, _ = w.run(w.exec_accounts(), bytes(data))
    check(f"randomizer is bound to the signature rc={rc}", rc == 13)
    st = P.unpack_state(bytes(w.state["data"]))
    rc, _ = w.run(w.exec_accounts(), w.signed_rekey(st["next"], w.key))
    check(f"rekey to the current root rejected rc={rc}", rc == 22)

    w2 = World(elf)
    w2.init()
    w2.wallet["lamports"] = 1_000_000
    data = bytearray(w2.signed_exec(P.EXEC_LEAF_LIMIT - 1, 2000, w2.transfer_inner(5)))
    rc, _ = w2.run(w2.exec_accounts(), bytes(data))
    check(f"exec at last allowed leaf {P.EXEC_LEAF_LIMIT - 1} rc={rc}", rc == 0)
    data = bytearray(w2.signed_exec(P.EXEC_LEAF_LIMIT, 2000, w2.transfer_inner(5)))
    rc, _ = w2.run(w2.exec_accounts(), bytes(data))
    check(f"exec in rekey reserve leaf {P.EXEC_LEAF_LIMIT} rejected rc={rc}", rc == 8)
    fresh_tree = wots.TreeKey.generate()
    rc, _ = w2.run(w2.exec_accounts(), w2.signed_rekey(wots.LEAVES - 1, fresh_tree))
    st = P.unpack_state(bytes(w2.state["data"]))
    check(f"rekey from the very last leaf rc={rc}", rc == 0 and st["root"] == fresh_tree.root and st["next"] == 0)

    rng = random.Random(7)
    mismatches = 0
    trials = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    for t in range(trials):
        base = P.unpack_state(bytes(w.state["data"]))
        leaf = base["next"] + rng.randrange(3)
        data = bytearray(w.signed_exec(leaf, 2000, w.transfer_inner(rng.randrange(1, 50))))
        mode = rng.randrange(6)
        if mode == 1:
            data[rng.randrange(len(data))] ^= 1 << rng.randrange(8)
        elif mode == 2:
            data = data[:rng.randrange(len(data))]
        elif mode == 3:
            data += bytes([rng.randrange(256)])
        elif mode == 4:
            pos = rng.randrange(P.EXEC_FIXED - 1, len(data))
            data[pos] = rng.randrange(256)
        elif mode == 5:
            data[0] = rng.choice([0, 2, 3, 255])
        data = bytes(data)
        accs_ref = snapshot(w.exec_accounts())
        accs_ref[0]["owner"] = w.prog
        try:
            _, new_state = R.process(w.prog, accs_ref, data, w.slot)
            want = 0
        except R.Reject as e:
            want = e.code
            new_state = None
        except Exception:
            want = "crash"
        before = snapshot(w.exec_accounts())
        try:
            got, _ = w.run(w.exec_accounts(), data)
        except emu.Fault as e:
            got = f"fault:{e}"
        if got != 0:
            for a, b in zip(w.exec_accounts(), before):
                a.update(b)
        same = got == want or (want == "crash" and got != 0)
        if want == 0 and got == 0 and bytes(w.state["data"]) != new_state:
            same = False
        if not same:
            mismatches += 1
            if mismatches <= 5:
                print(f"  mismatch trial {t} mode {mode}: program={got} model={want}")
    check(f"differential fuzz {trials} trials, mismatches={mismatches}", mismatches == 0)
    print("FAILED" if check.failed else "ALL PASSED", check.failed)


if __name__ == "__main__":
    main()
