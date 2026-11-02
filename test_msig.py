import copy
import hashlib
import os
import struct
import sys

import msig_protocol as M
import msig_ref as R

SYSTEM = bytes(32)
NOW = 1_800_000_000


def system_handler(prog, metas, data, accounts):
    if prog != SYSTEM:
        return
    by_key = {a["key"]: a for a in accounts}
    tag, = struct.unpack_from("<I", data, 0)
    if tag == 2:
        amt, = struct.unpack_from("<Q", data, 4)
        src, dst = by_key[metas[0][0]], by_key[metas[1][0]]
        if src.get("lamports", 0) < amt:
            raise RuntimeError("insufficient lamports")
        src["lamports"] -= amt
        dst["lamports"] = dst.get("lamports", 0) + amt
    elif tag == 8:
        space, = struct.unpack_from("<Q", data, 4)
        by_key[metas[0][0]]["data"] = bytearray(space)
    elif tag == 1:
        by_key[metas[0][0]]["owner"] = bytes(data[4:36])
    else:
        raise RuntimeError(f"unsupported system ix {tag}")


class RefBackend:
    name = "ref"

    def run(self, w, accounts, data, now):
        snap = copy.deepcopy([dict(a) for a in accounts])
        try:
            R.process(w.program, w.opeq, accounts, data, now, system_handler)
            return 0
        except R.Reject as e:
            for a, s in zip(accounts, snap):
                a.clear()
                a.update(s)
            return e.code


class EmuBackend:
    name = "emu"

    def __init__(self, elf):
        self.elf = elf

    def run(self, w, accounts, data, now):
        import emu
        snap = copy.deepcopy([dict(a) for a in accounts])
        try:
            vm = emu.Vm(self.elf, accounts, data, w.program, cpi_handler=system_handler, now=now)
            rc = vm.run()
        except emu.Fault as f:
            rc = f"fault: {f}"
        except RuntimeError as f:
            rc = f"cpi: {f}"
        if rc != 0:
            for a, s in zip(accounts, snap):
                a.clear()
                a.update(s)
        else:
            vm.sync() if hasattr(vm, "sync") else None
        return rc


def acct(key=None, **kw):
    a = {"key": key or os.urandom(32), "lamports": 0, "owner": SYSTEM, "data": bytearray(), "signer": False, "writable": False}
    a.update(kw)
    return a


class World:
    def __init__(self, backend, n_people=4):
        self.b = backend
        self.program = hashlib.sha256(b"vault program").digest()
        self.opeq = hashlib.sha256(b"opeq program").digest()
        self.now = NOW
        self.people = []
        for i in range(n_people):
            for bump in range(255, -1, -1):
                aid = hashlib.sha256(b"aid%d" % i).digest()
                try:
                    k = M.owner_wallet(aid, bump, self.opeq)
                    break
                except ValueError:
                    continue
            self.people.append({"aid": aid, "wbump": bump, "acc": acct(k, lamports=10**10, writable=True)})
        self.system = acct(SYSTEM, executable=True, owner=os.urandom(32))
        self.bob = acct(lamports=0, writable=True)

    def run(self, accounts, data):
        return self.b.run(self, accounts, data, self.now)

    def signer(self, i):
        a = self.people[i]["acc"]
        a["signer"] = True
        return a

    def unsign(self):
        for p in self.people:
            p["acc"]["signer"] = False

    def create(self, creator, owners, threshold, nonce=None):
        nonce = nonce or os.urandom(32)
        ckey = self.people[creator]["acc"]["key"]
        mkey, _ = M.ms_pda(ckey, nonce, self.program)
        self.ms = acct(mkey, writable=True)
        vkey, _ = M.vault_pda(mkey, self.program)
        self.vault = acct(vkey, writable=True)
        data = M.build_create(nonce, threshold, [(self.people[i]["aid"], self.people[i]["wbump"]) for i in owners])
        rc = self.run([self.signer(creator), self.ms, self.system], data)
        self.unsign()
        self.props = {}
        return rc

    def msinfo(self):
        return M.unpack_ms(self.ms["data"])

    def propose(self, who, ixs, expires=None, pid=None):
        info = self.msinfo()
        pid = info["next"] if pid is None else pid
        pkey, _ = M.proposal_pda(self.ms["key"], pid, self.program)
        prop = self.props.get(pid) or acct(pkey, writable=True)
        self.props[pid] = prop
        stored = ixs if isinstance(ixs, (bytes, bytearray)) else M.encode_stored(ixs)
        rc = self.run([self.signer(who), self.ms, prop, self.system], M.build_propose(expires or self.now + 3600, stored))
        self.unsign()
        return rc, pid

    def phash(self, pid):
        return M.unpack_proposal(self.props[pid]["data"])["hash"]

    def vote(self, who, pid, tag=M.IX_APPROVE, h=None):
        rc = self.run([self.signer(who), self.ms, self.props[pid]], M.build_vote(tag, pid, h or self.phash(pid)))
        self.unsign()
        return rc

    def cancel(self, who, pid):
        rc = self.run([self.signer(who), self.ms, self.props[pid]], M.build_cancel(pid))
        self.unsign()
        return rc

    def execute(self, who, pid, extra):
        rc = self.run([self.signer(who), self.ms, self.props[pid], self.vault] + extra, M.build_execute(pid))
        self.unsign()
        return rc

    def pay(self, to, amount):
        return [(SYSTEM, [(self.vault["key"], M.M_SIGNER | M.M_WRITABLE), (to["key"], M.M_WRITABLE)], struct.pack("<IQ", 2, amount))]


PASS = FAIL = 0


def ok(cond, msg):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print("  FAIL", msg)


def scenario(backend):
    w = World(backend)
    ok(w.create(0, [0, 1, 2], 2) == 0, "create 2 of 3")
    info = w.msinfo()
    ok(info["n"] == 3 and info["threshold"] == 2 and info["config"] == 1, "multisig state written")
    ok(w.ms["owner"] == w.program and w.ms["lamports"] == M.rent(M.MS_LEN), "multisig owned by the program and rent exempt")
    w.vault["lamports"] = 5 * 10**9
    rc, pid = w.propose(0, w.pay(w.bob, 10**9))
    ok(rc == 0 and pid == 0, f"propose ({rc})")
    p = M.unpack_proposal(w.props[0]["data"])
    ok(p["approvals"] == 1 and p["proposer"] == w.people[0]["acc"]["key"], "proposer approval recorded")
    ok(w.execute(1, 0, [w.bob, w.system]) == 26, "one approval is not enough")
    ok(w.vote(1, 0, h=bytes(32)) == 22, "approval bound to content")
    ok(w.vote(1, 0) == 0, "second owner approves")
    ok(w.vote(1, 0) == 23, "double approval refused")
    ok(w.execute(3, 0, [w.bob, w.system]) == 15, "outsider cannot execute")
    ok(w.execute(2, 0, [w.bob, w.system]) == 0 and w.bob["lamports"] == 10**9, "executed: bob paid")
    ok(w.execute(2, 0, [w.bob, w.system]) == 21, "replay refused")
    ok(w.vote(2, 0) == 21, "approving an executed proposal refused")

    rc, pid = w.propose(1, w.pay(w.bob, 1))
    ok(rc == 0 and pid == 1, "second proposal")
    ok(w.cancel(0, 1) == 25, "only the proposer cancels")
    ok(w.cancel(1, 1) == 0 and w.vote(0, 1) == 21, "cancelled proposal is dead")

    ok(w.propose(3, w.pay(w.bob, 1))[0] == 15, "outsider cannot propose")
    ok(w.propose(0, w.pay(w.bob, 1), expires=w.now)[0] == 17, "expiry must be in the future")
    ok(w.propose(0, w.pay(w.bob, 1), expires=w.now + M.MAX_LIFETIME + 1)[0] == 17, "lifetime capped at 30 days")
    evil = [(SYSTEM, [(w.people[1]["acc"]["key"], M.M_SIGNER | M.M_WRITABLE), (w.bob["key"], M.M_WRITABLE)], struct.pack("<IQ", 2, 1))]
    ok(w.propose(0, evil)[0] == 19, "a stored instruction cannot use another owner's signature")
    ok(w.propose(0, b"\x01" + bytes(10))[0] == 18, "truncated stored instructions refused")
    ok(w.propose(0, M.encode_stored(w.pay(w.bob, 1)) + b"\x00")[0] == 18, "trailing bytes refused")

    rc, pid = w.propose(0, w.pay(w.bob, 1), expires=w.now + 100)
    w.vote(1, pid)
    w.now += 101
    ok(w.execute(1, pid, [w.bob, w.system]) == 21, "expired proposal is dead")
    w.now -= 101

    rc, pay_pid = w.propose(0, w.pay(w.bob, 7))
    owners = [(w.people[i]["aid"], w.people[i]["wbump"]) for i in (0, 1)]
    rc, ch = w.propose(0, [(w.program, [], M.set_owners_data(1, owners))])
    ok(rc == 0, "owner change proposed")
    w.vote(1, ch)
    w.vote(1, pay_pid)
    ok(w.execute(0, ch, []) == 0, "owner change executed")
    info = w.msinfo()
    ok(info["n"] == 2 and info["threshold"] == 1 and info["config"] == 2, "owners and threshold changed, config bumped")
    ok(w.execute(0, pay_pid, [w.bob, w.system]) == 21, "pending proposals from the old config are void")
    ok(w.propose(2, w.pay(w.bob, 1))[0] == 15, "removed owner locked out")

    rc, bad = w.propose(0, [(w.program, [], M.set_owners_data(1, owners) + b"\x00")])
    ok(rc == 0 and w.execute(0, bad, []) == 18, "non-canonical owner change refused at execution")
    rc, dup = w.propose(0, [(w.program, [], M.set_owners_data(1, owners + owners[:1]))])
    ok(w.execute(0, dup, []) == 9, "duplicate owners refused")

    rc, pid = w.propose(0, w.pay(w.bob, 1))
    ok(w.execute(0, pid, [w.bob, w.system]) == 0, "1 of 2 executes alone after the change")
    ok(w.execute(0, pid, [w.system]) == 21, "still not twice")

    w2 = World(backend)
    ok(w2.create(0, [1, 2], 1) == 10, "creator must be an owner")
    ok(w2.create(0, [0, 0], 1) == 9, "duplicate owner at create")
    ok(w2.create(0, [0, 1], 3) == 7, "threshold above owners")
    ok(w2.create(0, [0, 1], 0) == 7, "zero threshold")
    w2.people[1]["wbump"] = (w2.people[1]["wbump"] + 1) % 256
    rc = w2.create(0, [0, 1], 1)
    ok(rc in (8,), f"owner that is not an OPEQ wallet refused ({rc})")


class DiffBackend:
    name = "diff"

    def __init__(self, elf):
        self.ref = RefBackend()
        self.emu = EmuBackend(elf)
        self.mismatches = 0
        self.runs = 0
        self.codes = {}

    def run(self, w, accounts, data, now):
        twin = copy.deepcopy(accounts)
        rc_e = self.emu.run(w, twin, data, now)
        rc_r = self.ref.run(w, accounts, data, now)
        self.runs += 1
        self.codes[rc_r] = self.codes.get(rc_r, 0) + 1
        same = rc_e == rc_r and all(
            (a.get("lamports", 0), a.get("owner"), bytes(a.get("data", b""))) == (b.get("lamports", 0), b.get("owner"), bytes(b.get("data", b"")))
            for a, b in zip(accounts, twin))
        if not same:
            self.mismatches += 1
            if self.mismatches <= 5:
                print("  MISMATCH tag", data[:1].hex(), "ref", rc_r, "emu", rc_e, "len", len(data))
        return rc_r


def fuzz(elf, trials):
    import random
    rng = random.Random(1234)
    b = DiffBackend(elf)
    for t in range(trials):
        w = World(b, n_people=5)
        k = rng.randint(1, 4)
        owners = rng.sample(range(5), k)
        creator = rng.choice(owners if rng.random() < 0.9 else range(5))
        thr = rng.randint(0 if rng.random() < 0.1 else 1, k + (1 if rng.random() < 0.1 else 0))
        if w.create(creator, owners, thr) != 0:
            continue
        w.vault["lamports"] = rng.randint(0, 3 * 10**9)
        for _ in range(rng.randint(5, 25)):
            op = rng.random()
            who = rng.randrange(5)
            if op < 0.3 or not w.props:
                if rng.random() < 0.2:
                    data = bytearray(M.encode_stored(w.pay(w.bob, rng.randint(1, 10**9))))
                    for _ in range(rng.randint(1, 3)):
                        data[rng.randrange(len(data))] = rng.randrange(256)
                    if rng.random() < 0.3:
                        data = data[:rng.randrange(len(data) + 1)]
                    ixs = bytes(data)
                elif rng.random() < 0.15:
                    sub = rng.sample(range(5), rng.randint(1, 4))
                    ixs = [(w.program, [], M.set_owners_data(rng.randint(0, len(sub) + 1), [(w.people[i]["aid"], w.people[i]["wbump"]) for i in sub]))]
                elif rng.random() < 0.1:
                    ixs = [(w.program, [], M.set_threshold_data(rng.randint(0, 6)))]
                else:
                    ixs = w.pay(w.bob, rng.randint(1, 2 * 10**9))
                exp = w.now + rng.choice([3600, -5, 0, M.MAX_LIFETIME, M.MAX_LIFETIME + 1, 100])
                w.propose(who, ixs, expires=exp)
            elif op < 0.55:
                pid = rng.choice(list(w.props))
                h = None if rng.random() < 0.85 else os.urandom(32)
                if w.props[pid].get("data"):
                    w.vote(who, pid, M.IX_APPROVE if rng.random() < 0.75 else M.IX_REVOKE, h=h or w.phash(pid) if len(w.props[pid]["data"]) >= 128 else os.urandom(32))
            elif op < 0.65:
                pid = rng.choice(list(w.props))
                w.cancel(who, pid)
            elif op < 0.9:
                pid = rng.choice(list(w.props))
                extra = rng.choice([[w.bob, w.system], [w.system], [w.bob], []])
                w.execute(who, pid, extra)
            else:
                w.now += rng.choice([1, 100, 3600, M.MAX_LIFETIME])
    print(f"fuzz: {b.runs} instructions compared, {b.mismatches} mismatches; outcomes {dict(sorted(b.codes.items(), key=lambda x: str(x[0])))}")
    return b.mismatches


def main():
    backends = [RefBackend()]
    if len(sys.argv) > 1 and sys.argv[1] == "emu":
        import msig_program
        backends = [RefBackend(), EmuBackend(msig_program.build(hashlib.sha256(b"opeq program").digest()).elf())]
    for b in backends:
        print("backend", b.name)
        scenario(b)
    bad = 0
    if len(sys.argv) > 1 and sys.argv[1] == "emu":
        import msig_program
        bad = fuzz(msig_program.build(hashlib.sha256(b"opeq program").digest()).elf(), int(sys.argv[2]) if len(sys.argv) > 2 else 200)
    print(f"{PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL or bad else 0)


if __name__ == "__main__":
    main()
