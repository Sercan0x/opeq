import base64
import json
import os
import shutil
import struct
import sys
import tempfile
from types import SimpleNamespace

os.environ["OPEQ_PASSWORD"] = "client-test-password"

import emu
import keystore
import mnemonic
import program
import protocol as P
import opeq
import wots
from solkit import Keypair, RpcError, b58decode, b58encode, find_pda, pk, ps
from test_emu import system_handler

ELF = program.build().elf()
SYSTEM = bytes(32)


def read_compact(b, i):
    n = s = 0
    while True:
        x = b[i]
        i += 1
        n |= (x & 0x7F) << s
        s += 7
        if not x & 0x80:
            return n, i


class FakeChain:
    def __init__(self, prog):
        self.prog = prog
        self.slot = 1000
        self.accounts = {}
        self.statuses = {}
        self.mode = "ok"
        self.held = []
        self.sent = 0
        pdata = find_pda([prog], opeq.LOADER)
        self.accounts[pdata] = {"owner": opeq.LOADER, "lamports": 1, "data": bytearray(45) + bytearray(ELF), "executable": False}
        self.accounts[prog] = {"owner": opeq.LOADER, "lamports": 1, "data": bytearray(36), "executable": True}
        self.accounts[SYSTEM] = {"owner": os.urandom(32), "lamports": 1, "data": bytearray(), "executable": True}

    def acc(self, key):
        return self.accounts.setdefault(key, {"owner": SYSTEM, "lamports": 0, "data": bytearray(), "executable": False})

    def call(self, method, params=None):
        params = params or []
        if method == "getSlot":
            self.slot += 7
            return self.slot
        if method == "getGenesisHash":
            return "FakeChainGenesisHash11111111111111111111111"
        if method == "getLatestBlockhash":
            return {"value": {"blockhash": b58encode(os.urandom(32))}}
        if method == "getMinimumBalanceForRentExemption":
            return 1_500_000
        if method == "getBalance":
            return {"value": self.acc(pk(params[0]))["lamports"]}
        if method == "getAccountInfo":
            a = self.accounts.get(pk(params[0]))
            if a is None or (a["lamports"] == 0 and not a["data"]):
                return {"value": None}
            return {"value": {"owner": ps(a["owner"]), "lamports": a["lamports"], "data": [base64.b64encode(bytes(a["data"])).decode(), "base64"]}}
        if method == "getSignatureStatuses":
            out = []
            for s in params[0]:
                st = self.statuses.get(s, "unknown")
                out.append(None if st == "unknown" else {"err": st, "confirmationStatus": "confirmed"})
            return {"value": out}
        if method == "sendTransaction":
            return self.send(base64.b64decode(params[0]), (params[1] or {}).get("skipPreflight", False))
        raise NotImplementedError(method)

    def parse(self, tx):
        nsig, i = read_compact(tx, 0)
        sig = tx[i:i + 64]
        msg = tx[i + 64 * nsig:]
        j = 1 if msg[0] & 0x80 else 0
        hdr = msg[j:j + 3]
        n, j = read_compact(msg, j + 3)
        keys = [msg[j + 32 * k:j + 32 * k + 32] for k in range(n)]
        j += 32 * n + 32
        nix, j = read_compact(msg, j)
        ixs = []
        for _ in range(nix):
            pi = msg[j]
            na, j = read_compact(msg, j + 1)
            accs = list(msg[j:j + na])
            dl, j = read_compact(msg, j + na)
            ixs.append((pi, accs, msg[j:j + dl]))
            j += dl
        ns, ros, rou = hdr

        def writable(k):
            return k < ns - ros if k < ns else k < n - rou

        return b58encode(sig), keys, ixs, ns, writable

    def send(self, tx, skip_preflight):
        sig, keys, ixs, ns, writable = self.parse(tx)
        if sig in self.statuses:
            return sig
        self.sent += 1
        if self.mode == "drop":
            self.held.append(tx)
            return sig
        err = self.execute(keys, ixs, ns, writable)
        if err is not None and not skip_preflight:
            raise RpcError({"message": f"Transaction simulation failed: custom program error: {hex(err) if isinstance(err, int) else err}", "data": {"logs": []}})
        self.statuses[sig] = None if err is None else {"InstructionError": [1, {"Custom": err}]}
        return sig

    def execute(self, keys, ixs, ns, writable):
        snapshot = {k: {**v, "data": bytearray(v["data"])} for k, v in self.accounts.items()}
        for pi, accs, data in ixs:
            prog = keys[pi]
            if prog == opeq.COMPUTE_BUDGET:
                continue
            views = []
            for a in accs:
                k = keys[a]
                st = self.acc(k)
                views.append({"key": k, "signer": a < ns, "writable": writable(a), "executable": st["executable"],
                              "owner": st["owner"], "lamports": st["lamports"], "data": bytearray(st["data"])})
            if prog == SYSTEM:
                try:
                    system_handler(prog, [(v["key"], v["signer"], v["writable"]) for v in views], data, views)
                except emu.Fault:
                    self.accounts = snapshot
                    return "system"
                rc = 0
            elif prog == self.prog:
                try:
                    vm = emu.Vm(ELF, views, bytes(data), self.prog, slot=self.slot, cpi_handler=system_handler)
                    rc = vm.run()
                except emu.Fault as e:
                    rc = f"fault {e}"
            else:
                rc = "unknown program"
            if rc != 0:
                self.accounts = snapshot
                return rc
            for v in views:
                a = self.acc(v["key"])
                a["owner"], a["lamports"], a["data"] = v["owner"], v["lamports"], bytearray(v["data"])
        return None

    def release_held(self):
        held, self.held = self.held, []
        landed = 0
        for tx in held:
            sig, keys, ixs, ns, writable = self.parse(tx)
            err = self.execute(keys, ixs, ns, writable)
            self.statuses[sig] = None if err is None else {"InstructionError": [1, {"Custom": err}]}
            landed += err is None
        return landed


class FakeRpc(opeq.Rpc):
    def __init__(self, chain):
        self.chain = chain
        self.url = "fake"
        self.priority = 0

    def call(self, method, params=None):
        return self.chain.call(method, params)


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        check.failed += 1


check.failed = 0


def expect_exit(fn, needle):
    try:
        fn()
    except SystemExit as e:
        return needle in str(e), str(e)
    return False, "no error"


def main():
    tmp = tempfile.mkdtemp(prefix="opeq-client-")
    prog = os.urandom(32)
    chain = FakeChain(prog)
    rpc = FakeRpc(chain)
    payer = Keypair.generate()
    chain.acc(payer.pub)["lamports"] = 10**12
    path = os.path.join(tmp, "vault.json")
    args = SimpleNamespace(vault=path, program=ps(prog), plaintext=False, yes=True, to=None, sol=None)
    opeq.cmd_keygen(args)
    raw = json.load(open(path))
    check("keygen: no plaintext seed, v2 blob, mac present", "sk_seed" not in raw and raw["sk_enc"]["v"] == 2 and "mac" in raw)

    v = opeq.Vault(path, lock=True)
    opeq.cmd_init(rpc, payer, v, args)
    st = opeq.chain_state(rpc, v)
    check("init on fake chain", st is not None and st["root"] == v.root)
    opeq.cmd_init(rpc, payer, v, args)
    check("second init treated as already done", True)
    chain.acc(v.wallet)["lamports"] = 2 * 10**9
    bob = Keypair.generate().pub

    args.to, args.sol = ps(bob), "0.25"
    opeq.cmd_send(rpc, payer, v, args)
    check("send 0.25 SOL", chain.acc(bob)["lamports"] == 250_000_000)

    ok, msg = expect_exit(lambda: opeq.Vault(path, lock=True), "in use")
    check(f"second process blocked by lock ({msg})", ok)
    os.close(v.lock_fd)

    raw = json.load(open(path))
    raw["next_leaf"] = 0
    json.dump(raw, open(path, "w"))
    v = opeq.Vault(path, lock=True)
    ok, msg = expect_exit(v.unlock, "integrity")
    check(f"rolled-back counter detected ({msg})", ok)
    os.close(v.lock_fd)
    raw["next_leaf"] = 1
    raw["mac"] = keystore.mac(keystore.unlock(raw["sk_enc"], "client-test-password", bytes.fromhex(raw["aid"]))[1], raw)
    json.dump(raw, open(path, "w"))

    evil = dict(raw)
    evil["sk_enc"] = {k: v_ for k, v_ in raw["sk_enc"].items() if k != "v"}
    evil_path = os.path.join(tmp, "evil.json")
    json.dump(evil, open(evil_path, "w"))
    ok, msg = expect_exit(opeq.Vault(evil_path).unlock, "unknown vault encryption format")
    check(f"format downgrade detected ({msg})", ok)
    evil = dict(raw)
    evil["program"] = ps(os.urandom(32))
    json.dump(evil, open(evil_path, "w"))
    ok, msg = expect_exit(opeq.Vault(evil_path).unlock, "integrity")
    check(f"swapped program address detected ({msg})", ok)

    v = opeq.Vault(path, lock=True)
    args.sol = "50"
    before = opeq.chain_state(rpc, v)["next"]
    try:
        opeq.cmd_send(rpc, payer, v, args)
        check("overdraft should fail", False)
    except opeq.Failed:
        pass
    after = opeq.chain_state(rpc, v)["next"]
    check(f"failed send burned: chain next {before} -> {after}", after >= before + 2)

    chain.mode = "drop"
    args.sol = "0.01"
    try:
        opeq.cmd_send(rpc, payer, v, args)
        check("dropped tx should not report success", False)
    except opeq.Failed as e:
        check(f"dropped tx waits for expiry ({str(e)[:60]}...)", "expired" in str(e))
    chain.mode = "ok"
    landed = chain.release_held()
    check(f"expired tx cannot land later (landed={landed})", landed == 0)
    bal = chain.acc(bob)["lamports"]
    opeq.cmd_send(rpc, payer, v, args)
    check("retry after expiry sends exactly once", chain.acc(bob)["lamports"] == bal + 10_000_000)
    os.close(v.lock_fd)

    v = opeq.Vault(path, lock=True)
    real_submit = opeq.submit

    def crash_after_landing(*a, **k):
        real_submit(*a, **k)
        raise KeyboardInterrupt

    opeq.submit = crash_after_landing
    try:
        opeq.cmd_rekey(rpc, payer, v, args)
    except KeyboardInterrupt:
        pass
    opeq.submit = real_submit
    os.close(v.lock_fd)
    check("rekey crashed after landing, no pending file needed", not glob_pending(path))
    v = opeq.Vault(path, lock=True)
    opeq.cmd_send(rpc, payer, v, args)
    st = opeq.chain_state(rpc, v)
    check(f"next command re-derived the landed tree (epoch {st['epoch']}, root match {st['root'] == v.root})",
          st["epoch"] == 1 and st["root"] == v.root)
    os.close(v.lock_fd)

    v = opeq.Vault(path, lock=True)

    def send_then_crash(*a, **k):
        orig = rpc.call

        def call(m, p=None):
            if m == "getSignatureStatuses":
                raise KeyboardInterrupt
            return orig(m, p)

        rpc.call = call
        try:
            return real_submit(*a, **k)
        finally:
            del rpc.call

    chain.mode = "drop"
    opeq.submit = send_then_crash
    try:
        opeq.cmd_rekey(rpc, payer, v, args)
    except KeyboardInterrupt:
        pass
    opeq.submit = real_submit
    chain.mode = "ok"
    opeq.cmd_rekey(rpc, payer, v, args)
    st = opeq.chain_state(rpc, v)
    check(f"rekey retried while the first is in flight (epoch {st['epoch']})", st["epoch"] == 2 and st["root"] == v.root)
    landed = chain.release_held()
    st = opeq.chain_state(rpc, v)
    check(f"stale first rekey cannot land afterwards (landed={landed}, epoch {st['epoch']})", landed == 0 and st["epoch"] == 2)
    os.close(v.lock_fd)

    v = opeq.Vault(path, lock=True)
    v.unlock()
    v.raw["next_leaf"] = P.EXEC_LEAF_LIMIT - 1
    v.save()
    opeq.cmd_send(rpc, payer, v, args)
    check("send at last normal leaf 1007", opeq.chain_state(rpc, v)["next"] == P.EXEC_LEAF_LIMIT)
    ok, msg = expect_exit(lambda: opeq.cmd_send(rpc, payer, v, args), "rekey")
    check(f"leaf 1008 refused for sends ({msg})", ok)
    opeq.cmd_rekey(rpc, payer, v, args)
    st = opeq.chain_state(rpc, v)
    check(f"rekey from the reserve works (epoch {st['epoch']}, next {st['next']})", st["epoch"] == 3 and st["next"] == 0)
    opeq.cmd_restore(rpc, payer, v, args)
    check("restore skips 64 leaves", v.raw["next_leaf"] == 64)
    words = mnemonic.to_words(v.master)
    wallet = v.wallet
    os.close(v.lock_fd)

    rec = os.path.join(tmp, "recovered.json")
    rargs = SimpleNamespace(vault=rec, program=ps(prog), plaintext=False, yes=True, to=ps(bob), sol="0.01")
    os.environ["OPEQ_WORDS"] = " ".join(words)
    opeq.cmd_recover(rpc, rargs)
    r = opeq.Vault(rec, lock=True)
    st = opeq.chain_state(rpc, r)
    check(f"recovered same wallet at tree {r.raw['epoch']} with counter {r.raw['next_leaf']}",
          r.wallet == wallet and r.raw["epoch"] == st["epoch"] == 3 and r.raw["next_leaf"] == st["next"] + opeq.RESTORE_GAP)
    bal = chain.acc(bob)["lamports"]
    opeq.cmd_send(rpc, payer, r, rargs)
    check("recovered vault can send", chain.acc(bob)["lamports"] == bal + 10_000_000)
    os.close(r.lock_fd)
    bad = list(words)
    bad[7] = "zoo" if bad[7] != "zoo" else "abandon"
    os.environ["OPEQ_WORDS"] = " ".join(bad)
    ok, msg = expect_exit(lambda: opeq.cmd_recover(rpc, SimpleNamespace(**{**vars(rargs), "vault": os.path.join(tmp, "x.json")})), "checksum")
    check(f"wrong word rejected ({msg})", ok)
    del os.environ["OPEQ_WORDS"]

    shutil.rmtree(tmp)
    print("FAILED" if check.failed else "ALL PASSED", check.failed)


def glob_pending(path):
    import glob
    return glob.glob(path + ".pending-*")


if __name__ == "__main__":
    main()
