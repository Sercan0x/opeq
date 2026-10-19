import argparse
import base64
import fcntl
import glob
import hashlib
import json
import os
import re
import secrets
import struct
import sys
import tempfile
import time
from decimal import Decimal, InvalidOperation

import keystore
import mnemonic
import protocol as P
import v0
import wots
from solkit import COMPUTE_BUDGET, RpcError, Rpc, b58decode, compact, find_pda, load_keypair, pk, ps, u8, u32

HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = pk("11111111111111111111111111111111")
LOADER = pk("BPFLoaderUpgradeab1e11111111111111111111111")
RENT = pk("SysvarRent111111111111111111111111111111111")
CLOCK = pk("SysvarC1ock11111111111111111111111111111111")
NETS = {"devnet": "https://api.devnet.solana.com", "mainnet": "https://api.mainnet-beta.solana.com"}
EXPIRY_SLOTS = 150
RESTORE_GAP = 64
REKEY_WARN = 32
EXEC_LIMIT = P.EXEC_LEAF_LIMIT - RESTORE_GAP
BUFFER_META = 37
PROGRAMDATA_META = 45


class Failed(Exception):
    pass


def fsync_dir(path):
    fd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json_atomic(path, raw, exclusive=False):
    if exclusive and os.path.exists(path):
        raise SystemExit(f"{path} already exists, refusing to overwrite")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".opeq-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(raw, fh)
            fh.flush()
            os.fsync(fh.fileno())
        if exclusive:
            os.link(tmp, path)
            os.unlink(tmp)
        else:
            os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    fsync_dir(path)


def tree_root(pub_seed_hex, leaves_hex):
    raw = bytes.fromhex(leaves_hex)
    leaves = [raw[i:i + wots.N] for i in range(0, len(raw), wots.N)]
    return wots.build_tree(bytes.fromhex(pub_seed_hex), leaves)[-1][0]


class Vault:
    def __init__(self, path, lock=False):
        self.path = path
        self.lock_fd = None
        if lock:
            self.lock_fd = os.open(os.path.realpath(path) + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise SystemExit("vault is in use by another opeq process, try again when it finishes") from None
        self.raw = json.load(open(path))
        self.program = pk(self.raw["program"])
        self.aid = bytes.fromhex(self.raw["aid"])
        self.state = P.state_pda(self.aid, self.program)[0]
        self.wallet = P.wallet_pda(self.aid, self.program)[0]
        self._key = None
        self._password = None
        self._mac_key = None

    @property
    def encrypted(self):
        return "sk_enc" in self.raw

    @property
    def has_master(self):
        return self.raw.get("seed_type") == "master"

    def password(self, confirm=False):
        if self._password is None:
            self._password = keystore.ask_password(confirm)
        return self._password

    def unlock(self):
        if self._key is not None:
            return self._key
        d = dict(self.raw)
        if self.encrypted:
            seed, mac_key = keystore.unlock(self.raw["sk_enc"], self.password(), self.aid)
            keystore.check_mac(mac_key, self.raw)
            self._mac_key = mac_key
        else:
            print("WARNING: plaintext vault file, no password and no tamper protection")
            seed = bytes.fromhex(self.raw["master"] if self.has_master else self.raw["sk_seed"])
        if self.has_master:
            self.master = seed
            sk_seed, pub_seed = mnemonic.tree_seeds(seed, self.raw.get("epoch", 0), self.program, bytes.fromhex(self.raw["pub_seed"]))
            if pub_seed.hex() != self.raw["pub_seed"]:
                raise SystemExit("vault tree does not match its master seed, refusing to sign")
            seed = sk_seed
        d["sk_seed"] = seed.hex()
        self._key = wots.TreeKey.from_json(d)
        return self._key

    @property
    def root(self):
        return tree_root(self.raw["pub_seed"], self.raw["leaves"])

    def tree_fields(self, tree):
        data = tree.to_json()
        if self.has_master:
            del data["sk_seed"]
            return data
        if self.encrypted:
            data["sk_enc"], _ = keystore.seal(tree.sk_seed, self.password(), self.aid)
            del data["sk_seed"]
        return data

    def save(self):
        if self.encrypted:
            if self._mac_key is None:
                raise SystemExit("internal error: saving an encrypted vault before unlocking it")
            self.raw["mac"] = keystore.mac(self._mac_key, self.raw)
        write_json_atomic(self.path, self.raw)

    def is_active(self):
        if "active" in self.raw:
            return self.raw["active"] is True
        return bytes(self.program) == mnemonic.LEGACY_PROGRAM

    def reserve_leaf(self, chain_next, limit):
        leaf = max(self.raw.get("next_leaf", 0), chain_next)
        if leaf >= limit:
            if limit < wots.LEAVES:
                raise SystemExit(f"leaf {leaf}: this key tree is used up for transactions, run `rekey` now")
            raise SystemExit("tree fully used, wallet can no longer be rekeyed")
        self.raw["next_leaf"] = leaf + 1
        self.save()
        if limit == EXEC_LIMIT and leaf >= EXEC_LIMIT - REKEY_WARN:
            print(f"NOTE: {EXEC_LIMIT - leaf - 1} signatures left before a rekey is required")
        return leaf

    def pending_files(self):
        return sorted(glob.glob(glob.escape(self.path) + ".pending-*"))


def chain_state(rpc, v):
    acc = rpc.account(v.state)
    if acc is None:
        return None
    if acc["owner"] != v.program:
        raise SystemExit("state account is not owned by the vault program")
    return P.unpack_state(acc["data"])


_formats = {}


def program_format(rpc, program):
    if program not in _formats:
        d = rpc.account(find_pda([program], LOADER))["data"]
        m = re.search(rb"opeq/(\d+)\.(\d+)", d)
        if not m or int(m.group(1)) not in P.LAYOUTS:
            raise SystemExit("program is not a known opeq version, refusing to sign for it")
        _formats[program] = int(m.group(1))
    return _formats[program]


def recover_pending(rpc, v, st, quiet=False):
    if v.has_master:
        return
    for f in v.pending_files():
        pend = json.load(open(f))
        root = tree_root(pend["pub_seed"], pend["leaves"])
        if st["root"] == root:
            v.raw.update({k: pend[k] for k in ("pub_seed", "leaves", "sk_enc", "sk_seed") if k in pend})
            v.raw["next_leaf"] = 0
            v.raw["epoch"] = st["epoch"]
            v._key = None
            if v.encrypted:
                _, v._mac_key = keystore.unlock(v.raw["sk_enc"], v.password(), v.aid)
            v.save()
            for g in v.pending_files():
                os.unlink(g)
            fsync_dir(v.path)
            if not quiet:
                print("recovered a rekey that landed earlier, vault now uses the new tree")
            return
        if st["root"] == v.root:
            slot = rpc.call("getSlot", [{"commitment": "confirmed"}])
            if slot <= pend["expiry"] + 2:
                raise SystemExit(f"a rekey is still in flight until slot {pend['expiry']}, wait about a minute and retry")
            os.unlink(f)
            fsync_dir(v.path)
            print("removed a rekey attempt that expired without landing")


def own_rekey(v, st):
    mark = v.raw.get("rekeying")
    if not mark or int(mark.get("epoch", -1)) != st["epoch"]:
        return False
    if not mnemonic.chain_seeded(v.program, st["epoch"]):
        return True
    return mark.get("pub_seed") == st["pub_seed"].hex()


def sync_epoch(v, st):
    if not v.has_master or st["epoch"] == v.raw.get("epoch", 0):
        return
    if st["epoch"] < v.raw.get("epoch", 0):
        raise SystemExit("on-chain epoch is behind this vault file, refusing to sign")
    if not own_rekey(v, st):
        v.raw["active"] = False
        v.save()
        raise SystemExit("this wallet was rekeyed from another copy, so this copy stopped signing. Run `takeover` to make this copy the only one that signs")
    new = mnemonic.tree(v.master, st["epoch"], v.program, st["pub_seed"])
    if new.root != st["root"]:
        raise SystemExit("on-chain tree is not derived from this vault's master seed, refusing to sign")
    v.raw.update(v.tree_fields(new))
    v.raw["epoch"] = st["epoch"]
    v.raw["next_leaf"] = 0
    v.raw["active"] = True
    v.raw.pop("rekeying", None)
    v._key = None
    v.save()
    print(f"vault now uses tree {st['epoch']} (this copy's rekey landed)")


def preflight(rpc, v):
    st = chain_state(rpc, v)
    if st is None:
        raise SystemExit("vault not initialized")
    key = v.unlock()
    recover_pending(rpc, v, st)
    sync_epoch(v, st)
    if not v.is_active():
        raise SystemExit("this copy of the wallet is not active. Run `takeover` to make it the only copy that signs")
    key = v.unlock()
    if st["root"] != v.root or st["pub_seed"].hex() != v.raw["pub_seed"]:
        raise SystemExit("on-chain root differs from this vault file, refusing to sign")
    if st["epoch"] != v.raw.get("epoch", st["epoch"]):
        raise SystemExit("on-chain epoch differs from this vault file, refusing to sign")
    genesis = rpc.call("getGenesisHash")
    if v.raw.get("cluster") is None:
        v.raw["cluster"] = genesis
        v.save()
    elif v.raw["cluster"] != genesis:
        raise SystemExit("this vault was created on a different cluster (genesis hash mismatch); signing here would reuse one-time keys, refusing")
    inflight = v.raw.get("inflight")
    if inflight:
        in_leaf, in_expiry = int(inflight["leaf"]), int(inflight["expiry"])
        if st["next"] > in_leaf:
            raise SystemExit(f"your interrupted transaction (leaf {in_leaf}) DID land on chain. Check the balance before sending again, "
                             f"then run `status` to clear this note")
        slot = rpc.call("getSlot", [{"commitment": "confirmed"}])
        if slot <= in_expiry + 2:
            raise SystemExit(f"your interrupted transaction (leaf {in_leaf}) may still land until slot {in_expiry}; "
                             f"wait, then run `status` and retry")
        v.raw.pop("inflight", None)
        v.save()
    return st, key


def check_leaf_key(key, leaf):
    if wots.leaf_pk(key.sk_seed, key.pub_seed, leaf) != key.levels[0][leaf]:
        raise SystemExit("secret seed does not match the stored tree, refusing to sign")


def outer_layout(v, inner, extra_accounts):
    outer = [v.state, v.wallet]
    for prog, metas, _ in inner:
        for k in [prog] + [m[0] for m in metas]:
            if k not in outer:
                outer.append(k)
    for k in extra_accounts:
        if k not in outer:
            outer.append(k)
    writable = {v.state, v.wallet}
    for _, metas, _ in inner:
        writable |= {m[0] for m in metas if m[2]}
    return outer, [(k, False, k in writable) for k in outer]


def submit(rpc, payer, ix, expiry, cu_limit, tables):
    ixs = [(COMPUTE_BUDGET, [], u8(2) + u32(cu_limit)), ix]
    bh = rpc.call("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]["blockhash"]
    msg, signer_keys = v0.compile_v0(payer.pub, ixs, b58decode(bh), tables or {})
    tx = compact(len(signer_keys)) + b"".join(payer.sign(msg) for _ in signer_keys) + msg
    if len(tx) > v0.MAX_TX:
        raise Failed(f"transaction too large: {len(tx)} bytes (use a lookup table)")
    raw = base64.b64encode(tx).decode()
    try:
        sig = rpc.call("sendTransaction", [raw, {"encoding": "base64", "preflightCommitment": "confirmed"}])
    except RpcError as e:
        err = e.args[0]
        if not isinstance(err, dict):
            raise Failed(str(err)) from None
        logs = (err.get("data") or {}).get("logs") or []
        raise Failed(err.get("message", str(err)) + "\n" + "\n".join(logs)) from None
    last = time.time()
    while True:
        st = rpc.call("getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])["value"][0]
        if st and st.get("err"):
            raise Failed(f"tx {sig} failed: {st['err']}")
        if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
            return sig
        slot = rpc.call("getSlot", [{"commitment": "confirmed"}])
        if slot > expiry + 2:
            st = rpc.call("getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])["value"][0]
            if st and not st.get("err"):
                return sig
            raise Failed(f"tx {sig} expired without landing at slot {expiry}; it can no longer execute, safe to retry")
        if time.time() - last > 4:
            try:
                rpc.call("sendTransaction", [raw, {"encoding": "base64", "skipPreflight": True}])
            except RpcError:
                pass
            last = time.time()
        time.sleep(1.5)


def sign_exec(rpc, v, key, st, leaf, inner, fmt):
    check_leaf_key(key, leaf)
    expiry = rpc.call("getSlot", [{"commitment": "confirmed"}]) + EXPIRY_SLOTS
    r = os.urandom(P.R_LEN) if P.LAYOUTS[fmt]["r"] is not None else b""
    salt, digest, cost = P.grind(P.exec_hasher(v.program, v.aid, st["epoch"], leaf, expiry, inner, fmt, r), fmt=fmt)
    sig, path = key.sign(leaf, digest)
    return expiry, salt, r, sig, path, cost


def burn(rpc, payer, v, key, failed_leaf, fmt):
    st = chain_state(rpc, v)
    if st["next"] > failed_leaf:
        return
    try:
        leaf = v.reserve_leaf(st["next"], P.EXEC_LEAF_LIMIT)
    except SystemExit:
        print(f"WARNING: no free leaf to burn {failed_leaf} with; it stays replayable until slot expiry")
        return
    expiry, salt, r, sig, path, _ = sign_exec(rpc, v, key, st, leaf, [], fmt)
    data = P.build_exec(leaf, expiry, salt, r, sig, path, [], [v.state, v.wallet], fmt)
    try:
        submit(rpc, payer, (v.program, [(v.state, False, True), (v.wallet, False, True)], data), expiry, 400_000, None)
        print(f"burned leaf {failed_leaf}: on-chain counter moved past it, the failed signature is now dead")
    except Failed as e:
        print(f"WARNING: could not burn leaf {failed_leaf} ({e}); it stays replayable until slot expiry")


def send_exec(rpc, payer, v, inner, extra_accounts=(), cu_limit=400_000, tables=None):
    st, key = preflight(rpc, v)
    fmt = program_format(rpc, v.program)
    leaf = v.reserve_leaf(st["next"], EXEC_LIMIT)
    expiry, salt, r, sig, path, cost = sign_exec(rpc, v, key, st, leaf, inner, fmt)
    v.raw["inflight"] = {"leaf": leaf, "expiry": expiry}
    v.save()
    outer, metas = outer_layout(v, inner, extra_accounts)
    data = P.build_exec(leaf, expiry, salt, r, sig, path, inner, outer, fmt)
    print(f"leaf {leaf}, format {fmt}, expiry slot {expiry}, on-chain hash steps {cost}, ix data {len(data)} bytes")
    try:
        sig = submit(rpc, payer, (v.program, metas, data), expiry, cu_limit, tables)
    except Failed as e:
        if "expired without landing" not in str(e):
            burn(rpc, payer, v, key, leaf, fmt)
        v.raw.pop("inflight", None)
        v.save()
        raise
    v.raw.pop("inflight", None)
    v.save()
    return sig


def parse_sol(text):
    try:
        lamports = Decimal(text) * 10**9
    except InvalidOperation:
        raise SystemExit(f"bad amount {text!r}") from None
    if lamports != lamports.to_integral_value() or lamports <= 0:
        raise SystemExit("amount must be positive with at most 9 decimals")
    return int(lamports)


def confirm(args, text):
    print(text)
    if args.yes:
        return
    if input("proceed? [y/N] ").strip().lower() != "y":
        raise SystemExit("cancelled, nothing was signed")


def show_words(words):
    print()
    print("RECOVERY WORDS. Write them on paper, in order. Anyone with these words controls the wallet.")
    print("They never change, even after rekey. opeq will not show them again unless you run `backup`.")
    print()
    for i in range(0, 24, 4):
        print("   " + "   ".join(f"{i + j + 1:2d}. {words[i + j]:<9}" for j in range(4)))
    print()


def quiz_words(words):
    import random
    for i in sorted(random.SystemRandom().sample(range(24), 3)):
        if input(f"type word #{i + 1}: ").strip().lower() != words[i]:
            raise SystemExit("that word does not match, nothing was saved. Run keygen again.")


def new_master_vault(path, program, master, password, epoch, root_check=None, next_leaf=0, pub_seed=None, active=True):
    tree = mnemonic.tree(master, epoch, pk(program), pub_seed)
    if root_check is not None and tree.root != root_check:
        raise SystemExit("these words do not control this wallet's current tree")
    tree0 = tree if epoch == 0 else mnemonic.tree(master, 0, pk(program))
    aid = P.account_id(tree0.pub_seed, tree0.root)
    raw = {**tree.to_json(), "seed_type": "master", "program": program, "aid": aid.hex(), "next_leaf": next_leaf, "epoch": epoch, "active": active}
    del raw["sk_seed"]
    if password is None:
        raw["master"] = master.hex()
    else:
        raw["sk_enc"], mac_key = keystore.seal(master, password, aid)
        raw["mac"] = keystore.mac(mac_key, raw)
    write_json_atomic(path, raw, exclusive=True)
    return aid


def cmd_keygen(args):
    if os.path.exists(args.vault):
        raise SystemExit(f"{args.vault} already exists, refusing to overwrite")
    pk(args.program)
    master = mnemonic.new_master()
    words = mnemonic.to_words(master)
    show_words(words)
    if not args.yes:
        input("press Enter when the words are written down...")
        print("\n" * 40)
        quiz_words(words)
    password = None if args.plaintext else keystore.ask_password(confirm=True)
    aid = new_master_vault(args.vault, args.program, master, password, 0)
    print("quantum wallet address:", ps(P.wallet_pda(aid, pk(args.program))[0]), "(PLAINTEXT key file)" if args.plaintext else "(encrypted)")


def cmd_backup(args):
    v = Vault(args.vault, lock=True)
    if not v.has_master:
        raise SystemExit("this vault was created before recovery words existed; make a new vault and move funds or authority to it")
    v.unlock()
    show_words(mnemonic.to_words(v.master))


def cmd_recover(rpc, args):
    if os.path.exists(args.vault):
        raise SystemExit(f"{args.vault} already exists, choose another --vault path")
    program = pk(args.program)
    text = os.environ.get("OPEQ_WORDS") or input("enter the 24 words separated by spaces: ")
    try:
        master = mnemonic.from_words(text)
    except ValueError as e:
        raise SystemExit(str(e)) from None
    tree0 = mnemonic.tree(master, 0, program)
    aid = P.account_id(tree0.pub_seed, tree0.root)
    state = P.state_pda(aid, program)[0]
    acc = rpc.account(state)
    chain_seed = None
    if acc is None:
        epoch, root, next_leaf = 0, None, 0
        print("this wallet was never initialized on chain")
    else:
        if acc["owner"] != program:
            raise SystemExit("state account is not owned by the program")
        st = P.unpack_state(acc["data"])
        epoch, root, chain_seed = st["epoch"], st["root"], st["pub_seed"]
        next_leaf = st["next"]
        if next_leaf + RESTORE_GAP >= wots.LEAVES:
            raise SystemExit(f"refusing to recover: the current tree has fewer than {RESTORE_GAP} unused keys, so a lost copy could have "
                             f"signed with the last key. Rekey from the original wallet copy if you still have it, or wait for its "
                             f"in-flight rekey to land, then recover again")
    password = None if args.plaintext else keystore.ask_password(confirm=True)
    new_master_vault(args.vault, args.program, master, password, epoch, root, next_leaf, chain_seed, active=False)
    print(f"recovered wallet {ps(P.wallet_pda(aid, program)[0])} at tree {epoch}. This copy does not sign yet: run `takeover` to make it the only copy that signs; any other copy then stops")


def cmd_encrypt(args):
    v = Vault(args.vault, lock=True)
    if v.encrypted:
        raise SystemExit("already encrypted")
    seed = bytes.fromhex(v.raw.pop("master" if v.has_master else "sk_seed"))
    v.raw["sk_enc"], v._mac_key = keystore.seal(seed, v.password(confirm=True), v.aid)
    if keystore.unlock(v.raw["sk_enc"], v.password(), v.aid)[0] != seed:
        raise SystemExit("self-check failed, file unchanged")
    v.save()
    print("encrypted", args.vault)


def cmd_init(rpc, payer, v, args):
    v.unlock()
    lamports = rpc.rent(P.STATE_LEN)
    ix = (v.program, [(payer.pub, True, True), (v.state, False, True), (v.wallet, False, False), (SYSTEM, False, False)],
          P.build_init(bytes.fromhex(v.raw["pub_seed"]), v.root, lamports))
    try:
        sig = rpc.send([ix], [payer], cu_limit=50_000)
        print("initialized", sig)
    except RpcError as e:
        st = chain_state(rpc, v)
        if st and st["root"] == v.root and st["pub_seed"].hex() == v.raw["pub_seed"]:
            print("already initialized with this key (someone ran init for you), nothing to do")
            return
        raise e


def cmd_send(rpc, payer, v, args):
    to = pk(args.to)
    lamports = parse_sol(args.sol)
    confirm(args, f"send {Decimal(lamports) / 10**9} SOL from {ps(v.wallet)} to {ps(to)}")
    inner = [(SYSTEM, [(v.wallet, True, True), (to, False, True)], struct.pack("<IQ", 2, lamports))]
    print("sent", send_exec(rpc, payer, v, inner))


def cmd_burn(rpc, payer, v, args):
    print("burned", send_exec(rpc, payer, v, []))


def cmd_status(rpc, payer, v, args):
    st = chain_state(rpc, v)
    print("program ", ps(v.program), f"(format {program_format(rpc, v.program)})")
    print("wallet  ", ps(v.wallet), rpc.balance(v.wallet) / 1e9, "SOL")
    print("state   ", ps(v.state))
    if st:
        print("on-chain next leaf", st["next"], "epoch", st["epoch"], "root match", st["root"] == v.root)
        print("signatures left before rekey", max(0, EXEC_LIMIT - max(st["next"], v.raw.get("next_leaf", 0))))
        print("this copy signs:", "yes" if v.is_active() else "no, run `takeover` to use it here")
    else:
        print("not initialized")
    print("local next leaf", v.raw.get("next_leaf"), "| pending rekey files", len(v.pending_files()))
    inflight = v.raw.get("inflight")
    if inflight:
        in_leaf, in_expiry = int(inflight["leaf"]), int(inflight["expiry"])
        if st and st["next"] > in_leaf:
            print(f"NOTE: an interrupted transaction (leaf {in_leaf}) DID land on chain; check the balance above. Note cleared.")
            clear = True
        else:
            slot = rpc.call("getSlot", [{"commitment": "confirmed"}])
            clear = slot > in_expiry + 2
            if clear:
                print(f"NOTE: an interrupted transaction (leaf {in_leaf}) expired without landing. Note cleared, safe to retry.")
            else:
                print(f"NOTE: an interrupted transaction (leaf {in_leaf}) may still land until slot {in_expiry} (now {slot}); run status again later.")
        if clear:
            v.unlock()
            v.raw.pop("inflight", None)
            v.save()


def cmd_restore(rpc, payer, v, args):
    st, _ = preflight(rpc, v)
    new = max(v.raw.get("next_leaf", 0), st["next"]) + RESTORE_GAP
    v.raw["next_leaf"] = new
    v.save()
    print(f"local counter moved to {new}: leaves that an older copy of this file may have signed are skipped")


def cmd_rekey(rpc, payer, v, args):
    st, key = preflight(rpc, v)
    leaf = v.reserve_leaf(st["next"], wots.LEAVES)
    do_rekey(rpc, payer, v, st, key, leaf)


def cmd_takeover(rpc, payer, v, args):
    if not v.has_master:
        raise SystemExit("takeover needs a vault made from recovery words")
    st = chain_state(rpc, v)
    if st is None:
        raise SystemExit("vault not initialized")
    v.unlock()
    genesis = rpc.call("getGenesisHash")
    if v.raw.get("cluster") not in (None, genesis):
        raise SystemExit("this vault was created on a different cluster (genesis hash mismatch), refusing")
    if st["epoch"] < v.raw.get("epoch", 0):
        raise SystemExit("on-chain epoch is behind this vault file, refusing to sign")
    if st["epoch"] != v.raw.get("epoch", 0):
        cur = mnemonic.tree(v.master, st["epoch"], v.program, st["pub_seed"])
        if cur.root != st["root"]:
            raise SystemExit("on-chain tree is not derived from this vault's master seed, refusing to sign")
        v.raw.update(v.tree_fields(cur))
        v.raw.update({"epoch": st["epoch"], "next_leaf": st["next"], "active": False})
        v.raw.pop("rekeying", None)
        v.raw.pop("inflight", None)
        v._key = None
        v.save()
    lo = max(v.raw.get("next_leaf", 0), st["next"] + RESTORE_GAP)
    if lo >= wots.LEAVES:
        raise SystemExit("the current key tree is too far used to take over safely; take over from the copy that is active")
    confirm(args, "make this copy the only one that signs (one rekey transaction; every other copy stops signing)")
    leaf = lo + secrets.randbelow(wots.LEAVES - lo)
    v.raw["next_leaf"] = leaf + 1
    v.raw["cluster"] = genesis
    v.save()
    do_rekey(rpc, payer, v, st, v.unlock(), leaf)


def do_rekey(rpc, payer, v, st, key, leaf):
    fmt = program_format(rpc, v.program)
    check_leaf_key(key, leaf)
    expiry = rpc.call("getSlot", [{"commitment": "confirmed"}]) + EXPIRY_SLOTS
    pend_path = None
    if v.has_master:
        seed = os.urandom(wots.N) if mnemonic.chain_seeded(v.program, st["epoch"] + 1) else None
        new = mnemonic.tree(v.master, st["epoch"] + 1, v.program, seed)
        v.raw["rekeying"] = {"epoch": st["epoch"] + 1, "pub_seed": new.pub_seed.hex(), "leaf": leaf, "expiry": expiry}
        v.save()
    else:
        new = wots.TreeKey.generate()
        pend = {**v.tree_fields(new), "expiry": expiry}
        pend_path = v.path + ".pending-" + new.root.hex()[:16]
        write_json_atomic(pend_path, pend, exclusive=True)
    r = os.urandom(P.R_LEN) if P.LAYOUTS[fmt]["r"] is not None else b""
    salt, d, _ = P.grind(P.rekey_hasher(v.program, v.aid, st["epoch"], leaf, expiry, new.pub_seed, new.root, fmt, r), fmt=fmt)
    sig, path = key.sign(leaf, d)
    data = P.build_rekey(leaf, expiry, salt, r, sig, path, new.pub_seed, new.root, fmt)
    try:
        tx = submit(rpc, payer, (v.program, [(v.state, False, True), (v.wallet, False, False)], data), expiry, 400_000, None)
    except Failed as e:
        if pend_path and "expired without landing" in str(e):
            os.unlink(pend_path)
            fsync_dir(pend_path)
        elif pend_path:
            print("rekey failed; the pending tree is kept until the attempt expires")
        raise
    st = chain_state(rpc, v)
    if v.has_master:
        sync_epoch(v, st)
    else:
        recover_pending(rpc, v, st, quiet=True)
    print("rekeyed, this copy now signs with the new tree", tx)


def programdata_of(program):
    return find_pda([program], LOADER)


def upgrade_authority(rpc, program):
    d = rpc.account(programdata_of(program))["data"]
    return d[13:45] if d[12] == 1 else None


def cmd_set_authority(rpc, payer, v, args):
    v.unlock()
    target = pk(args.target)
    cur = upgrade_authority(rpc, target)
    if cur != payer.pub:
        raise SystemExit(f"upgrade authority is {ps(cur) if cur else 'none'}, not the payer key")
    confirm(args, f"hand upgrade authority of {ps(target)} to quantum wallet {ps(v.wallet)}")
    sig = rpc.send([(LOADER, [(programdata_of(target), False, True), (payer.pub, True, False), (v.wallet, False, False)], u32(4))], [payer])
    print("upgrade authority of", ps(target), "->", ps(v.wallet), sig)


def cmd_hand_authority(rpc, payer, v, args):
    target = pk(args.target)
    new_auth = pk(args.new_authority)
    if upgrade_authority(rpc, target) != v.wallet:
        raise SystemExit("this vault is not the upgrade authority of the target program")
    if rpc.account(new_auth) is None:
        print("NOTE: the new authority address has no account yet; make sure it is a wallet you control")
    confirm(args, f"move upgrade authority of {ps(target)} from {ps(v.wallet)} to {ps(new_auth)}")
    inner = [(LOADER, [(programdata_of(target), False, True), (v.wallet, True, False), (new_auth, False, False)], u32(4))]
    print("authority moved", send_exec(rpc, payer, v, inner))


def cmd_upgrade(rpc, payer, v, args):
    import deploy
    target = pk(args.target)
    elf = open(args.elf, "rb").read()
    if upgrade_authority(rpc, target) != v.wallet:
        raise SystemExit("this vault is not the upgrade authority of the target program")
    if not re.search(rb"opeq/\d+\.\d+", elf):
        raise SystemExit("the elf carries no opeq/<version> tag; refusing to upgrade to an unknown program")
    pd = rpc.account(programdata_of(target))
    if len(elf) > len(pd["data"]) - deploy.PROGRAMDATA_META:
        raise SystemExit("the elf is larger than the program's reserved size (max_len); refusing")
    if args.buffer:
        buf_key = pk(args.buffer)
    else:
        buf = deploy.write_buffer(rpc, payer, elf)
        confirm(args, f"hand buffer {ps(buf.pub)} to the vault and upgrade {ps(target)} to {args.elf} (sha256 {hashlib.sha256(elf).hexdigest()[:16]})")
        rpc.send([(LOADER, [(buf.pub, False, True), (payer.pub, True, False), (v.wallet, False, False)], u32(4))], [payer])
        buf_key = buf.pub
    acc = rpc.account(buf_key)
    d = acc["data"]
    ok = (acc["owner"] == LOADER and d[:4] == u32(1) and d[4] == 1 and d[5:37] == v.wallet
          and len(d) == BUFFER_META + len(elf) and d[BUFFER_META:] == elf)
    if not ok:
        raise SystemExit("buffer check failed: owner, authority, size or contents differ from the local elf, not signing")
    confirm(args, f"upgrade {ps(target)} to {args.elf} (sha256 {hashlib.sha256(elf).hexdigest()[:16]}) from buffer {ps(buf_key)}")
    inner = [(LOADER, [
        (programdata_of(target), False, True), (target, False, True), (buf_key, False, True), (payer.pub, False, True),
        (RENT, False, False), (CLOCK, False, False), (v.wallet, True, False),
    ], u32(3))]
    print("upgraded", send_exec(rpc, payer, v, inner))
    _formats.pop(target, None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["keygen", "backup", "recover", "encrypt", "init", "status", "send", "burn", "restore", "rekey", "takeover", "set-authority", "hand-authority", "upgrade"])
    ap.add_argument("--net", default="devnet", choices=list(NETS))
    ap.add_argument("--payer", default=os.path.join(HERE, "devnet-key.json"))
    ap.add_argument("--vault", default=os.path.join(HERE, "vault.json"))
    ap.add_argument("--program")
    ap.add_argument("--to")
    ap.add_argument("--sol")
    ap.add_argument("--target")
    ap.add_argument("--new-authority")
    ap.add_argument("--elf")
    ap.add_argument("--buffer")
    ap.add_argument("--plaintext", action="store_true")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()
    if args.cmd == "keygen":
        return cmd_keygen(args)
    if args.cmd == "encrypt":
        return cmd_encrypt(args)
    if args.cmd == "backup":
        return cmd_backup(args)
    rpc = Rpc(NETS[args.net])
    if args.cmd == "recover":
        return cmd_recover(rpc, args)
    payer = load_keypair(args.payer)
    v = Vault(args.vault, lock=args.cmd != "status")
    try:
        {"init": cmd_init, "status": cmd_status, "send": cmd_send, "burn": cmd_burn, "restore": cmd_restore,
         "rekey": cmd_rekey, "takeover": cmd_takeover, "set-authority": cmd_set_authority, "hand-authority": cmd_hand_authority, "upgrade": cmd_upgrade}[args.cmd](rpc, payer, v, args)
    except (RpcError, Failed) as e:
        msg = str(e)
        failed = re.findall(r"Program (\w+) failed: custom program error: (0x[0-9a-f]+)", msg)
        if failed and failed[0][0] == ps(v.program):
            code = int(failed[0][1], 16)
            msg += f"\nopeq error {code}: {P.ERRORS.get(code, 'unknown')}"
        raise SystemExit(msg)


if __name__ == "__main__":
    sys.exit(main())
