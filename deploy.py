import argparse
import json
import os
import re
import struct
import sys
import time

from solkit import Keypair, Rpc, find_pda, load_keypair, pk, ps, u32, u64

HERE = os.path.dirname(os.path.abspath(__file__))
LOADER = pk("BPFLoaderUpgradeab1e11111111111111111111111")
SYSTEM = pk("11111111111111111111111111111111")
RENT = pk("SysvarRent111111111111111111111111111111111")
CLOCK = pk("SysvarC1ock11111111111111111111111111111111")
NETS = {"devnet": "https://api.devnet.solana.com", "mainnet": "https://api.mainnet-beta.solana.com"}
GENESIS = {"devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"}
CHUNK = 900
BUFFER_META = 37
PROGRAM_LEN = 36
PROGRAMDATA_META = 45


def create_account(payer, new, lamports, space, owner):
    return (SYSTEM, [(payer, True, True), (new, True, True)], u32(0) + u64(lamports) + u64(space) + owner)


def write_buffer(rpc, payer, elf):
    buf = Keypair.generate()
    size = BUFFER_META + len(elf)
    rpc.send([
        create_account(payer.pub, buf.pub, rpc.rent(size), size, LOADER),
        (LOADER, [(buf.pub, False, True), (payer.pub, False, False)], u32(0)),
    ], [payer, buf])
    print("buffer", ps(buf.pub))
    for off in range(0, len(elf), CHUNK):
        part = elf[off:off + CHUNK]
        rpc.send([(LOADER, [(buf.pub, False, True), (payer.pub, True, False)], u32(1) + u32(off) + u64(len(part)) + part)], [payer])
        print(f"  wrote {off + len(part)}/{len(elf)}")
    acc = rpc.account(buf.pub)
    if acc is None or acc["owner"] != LOADER or bytes(acc["data"][BUFFER_META:]) != elf:
        raise SystemExit(f"buffer {ps(buf.pub)} does not hold the exact elf bytes, stopping before deploy")
    return buf


def deploy(rpc, payer, elf, prog_kp, max_len, authority=None):
    buf = write_buffer(rpc, payer, elf)
    pdata = find_pda([prog_kp.pub], LOADER)
    ixs = [
        create_account(payer.pub, prog_kp.pub, rpc.rent(PROGRAM_LEN), PROGRAM_LEN, LOADER),
        (LOADER, [
            (payer.pub, True, True), (pdata, False, True), (prog_kp.pub, False, True), (buf.pub, False, True),
            (RENT, False, False), (CLOCK, False, False), (SYSTEM, False, False), (payer.pub, True, False),
        ], u32(2) + u64(max_len)),
    ]
    if authority == "none":
        ixs.append((LOADER, [(pdata, False, True), (payer.pub, True, False)], u32(4)))
    elif authority is not None:
        ixs.append((LOADER, [(pdata, False, True), (payer.pub, True, False), (authority, False, False)], u32(4)))
    sig = rpc.send(ixs, [payer, prog_kp], cu_limit=400_000)
    acc = rpc.account(pdata)
    data = bytes(acc["data"])
    auth = data[13:45] if data[12] == 1 else None
    code = data[PROGRAMDATA_META:]
    if code[:len(elf)] != elf or any(code[len(elf):]):
        raise SystemExit("deployed program code differs from the elf")
    if authority == "none":
        if auth is not None:
            raise SystemExit(f"program should be immutable but its authority is {ps(auth)}")
        print("program is IMMUTABLE (no upgrade authority, set in the same transaction)")
        return sig
    expected = authority if authority is not None else payer.pub
    if auth != expected:
        raise SystemExit(f"upgrade authority is {auth and ps(auth)}, expected {ps(expected)}")
    print("upgrade authority", ps(auth), "(handed over in the same transaction)" if authority is not None else "(the payer key)")
    return sig


def upgrade(rpc, payer, elf, program):
    buf = write_buffer(rpc, payer, elf)
    pdata = find_pda([program], LOADER)
    return rpc.send([(LOADER, [
        (pdata, False, True), (program, False, True), (buf.pub, False, True), (payer.pub, False, True),
        (RENT, False, False), (CLOCK, False, False), (payer.pub, True, False),
    ], u32(3))], [payer], cu_limit=400_000)


def elf_version(elf):
    m = re.search(rb"opeq/(\d+)\.(\d+)", elf)
    return (int(m.group(1)), int(m.group(2))) if m else None


def check_elf(elf, sha):
    import hashlib
    if elf[:4] != b"\x7fELF" or not elf_version(elf):
        raise SystemExit("the elf is not an opeq program build (no ELF header or opeq/<version> tag)")
    if sha is not None and hashlib.sha256(elf).hexdigest() != sha.lower():
        raise SystemExit("the elf sha256 does not match --sha256")


def code_of(rpc, program):
    pd = rpc.account(find_pda([program], LOADER))
    if pd is None:
        raise SystemExit(f"{ps(program)} has no program data on this cluster")
    return bytes(pd["data"])


def vault_authority(rpc, path, elf=None):
    import opeq
    import protocol as P
    if not os.path.isfile(path):
        raise SystemExit(f"vault file {path} not found")
    raw = json.load(open(path))
    gov, aid = pk(raw["program"]), bytes.fromhex(raw["aid"])
    acc = rpc.account(gov)
    if acc is None or acc["owner"] != LOADER or not acc.get("executable", True):
        raise SystemExit(f"the vault's program {ps(gov)} is not a deployed program on this cluster")
    pd = code_of(rpc, gov)
    if pd[12] != 0:
        raise SystemExit(f"the vault's program {ps(gov)} still has an upgrade authority; the admin vault must live on an immutable program")
    if elf is not None and (pd[PROGRAMDATA_META:PROGRAMDATA_META + len(elf)] != elf or any(pd[PROGRAMDATA_META + len(elf):])):
        raise SystemExit(f"the vault's program {ps(gov)} does not run the same opeq code as --elf")
    state, wallet = P.state_pda(aid, gov)[0], P.wallet_pda(aid, gov)[0]
    st = rpc.account(state)
    if st is None or st["owner"] != gov:
        raise SystemExit("the admin vault is not initialized on this cluster; run `opeq.py init` for it first")
    chain = P.unpack_state(bytes(st["data"]))
    if chain["root"] != opeq.tree_root(raw["pub_seed"], raw["leaves"]) or chain["pub_seed"].hex() != raw["pub_seed"]:
        raise SystemExit("the admin vault file does not match its on-chain state")
    return wallet


def confirm_typed(text, expect):
    print(text)
    if input(f"this cannot be undone. Type {expect!r} to proceed: ").strip() != expect:
        raise SystemExit("cancelled, nothing was sent")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["newkey", "airdrop", "balance", "deploy", "upgrade", "close-buffer"])
    ap.add_argument("--net", default="devnet", choices=list(NETS))
    ap.add_argument("--rpc")
    ap.add_argument("--priority-fee", type=int, default=0)
    ap.add_argument("--sha256")
    ap.add_argument("--buffer")
    ap.add_argument("--key")
    ap.add_argument("--elf")
    ap.add_argument("--program-key")
    ap.add_argument("--program")
    ap.add_argument("--max-len", type=int, default=0)
    ap.add_argument("--authority")
    ap.add_argument("--authority-vault")
    args = ap.parse_args()
    if args.key is None:
        if args.net == "mainnet":
            raise SystemExit("on mainnet pass --key <payer keypair file> explicitly")
        args.key = os.path.join(HERE, "devnet-key.json")
    rpc = Rpc(args.rpc or NETS[args.net], priority=args.priority_fee)
    if args.cmd == "newkey":
        kp = Keypair.generate()
        kp.save(args.key)
        print(ps(kp.pub))
        return
    genesis = rpc.call("getGenesisHash")
    if genesis != GENESIS[args.net]:
        raise SystemExit(f"the RPC is not {args.net} (genesis {genesis})")
    print("rpc", (args.rpc or NETS[args.net]).split("?")[0], "network", args.net, "(genesis checked)")
    payer = load_keypair(args.key)
    if args.cmd == "balance":
        print(ps(payer.pub), rpc.balance(payer.pub) / 1e9, "SOL")
    elif args.cmd == "airdrop":
        sig = rpc.call("requestAirdrop", [ps(payer.pub), 2_000_000_000])
        for _ in range(40):
            st = rpc.call("getSignatureStatuses", [[sig]])["value"][0]
            if st and st.get("confirmationStatus") in ("confirmed", "finalized"):
                break
            time.sleep(1.5)
        print(ps(payer.pub), rpc.balance(payer.pub) / 1e9, "SOL")
    elif args.cmd == "close-buffer":
        buf = pk(args.buffer)
        acc = rpc.account(buf)
        if acc is None or acc["owner"] != LOADER or bytes(acc["data"])[:4] != u32(1):
            raise SystemExit("that address is not a loader buffer")
        d = bytes(acc["data"])
        if d[4] != 1 or d[5:37] != payer.pub:
            raise SystemExit("the buffer's authority is not this payer; close it from the vault that owns it")
        print("closed", rpc.send([(LOADER, [(buf, False, True), (payer.pub, False, True), (payer.pub, True, False)], u32(5))], [payer]))
    elif args.cmd == "deploy":
        if not args.elf or not os.path.isfile(args.elf):
            raise SystemExit("pass --elf <program file>")
        elf = open(args.elf, "rb").read()
        check_elf(elf, args.sha256)
        if args.net == "mainnet":
            if not args.program_key or not args.max_len or not args.sha256:
                raise SystemExit("a mainnet deploy needs explicit --program-key, --max-len and --sha256")
            if args.authority not in (None, "none"):
                raise SystemExit("on mainnet pass --authority none (immutable) or --authority-vault <admin vault file>, never a typed address")
            if bool(args.authority) == bool(args.authority_vault):
                raise SystemExit("a mainnet deploy needs exactly one of --authority none or --authority-vault <admin vault file>")
        if args.program_key and os.path.exists(args.program_key):
            prog = load_keypair(args.program_key)
            if args.net == "mainnet" and Rpc(NETS["devnet"]).account(prog.pub) is not None:
                raise SystemExit(f"refusing: program {ps(prog.pub)} already exists on devnet. A program id must never live on two clusters, "
                                 f"or signatures made on one could be replayed on the other. Use a fresh --program-key for mainnet.")
        else:
            prog = Keypair.generate()
        if args.net == "mainnet" and Rpc(NETS["devnet"]).account(prog.pub) is not None:
            raise SystemExit("refusing: this program id exists on devnet")
        if rpc.account(prog.pub) is not None:
            raise SystemExit(f"program {ps(prog.pub)} already exists on {args.net}")
        max_len = max(args.max_len, len(elf))
        if args.authority_vault:
            auth = vault_authority(rpc, args.authority_vault, elf)
        else:
            auth = None if not args.authority else ("none" if args.authority == "none" else pk(args.authority))
        import hashlib
        print(f"network {args.net}\npayer {ps(payer.pub)}\nprogram {ps(prog.pub)}\nelf sha256 {hashlib.sha256(elf).hexdigest()} ({len(elf)} bytes)\nmax_len {max_len}")
        print("upgrade authority after deploy:", "NONE, immutable forever" if auth == "none" else ps(auth) if auth else f"the payer {ps(payer.pub)}")
        if args.net == "mainnet":
            confirm_typed("check every line above", "IMMUTABLE" if auth == "none" else ps(auth)[-8:])
        if args.program_key and not os.path.exists(args.program_key):
            prog.save(args.program_key)
        print("deployed", deploy(rpc, payer, elf, prog, max_len, auth))
    elif args.cmd == "upgrade":
        if not args.elf or not os.path.isfile(args.elf) or not args.program:
            raise SystemExit("pass --elf <program file> and --program <id>")
        elf = open(args.elf, "rb").read()
        check_elf(elf, args.sha256)
        pd = code_of(rpc, pk(args.program))
        if pd[12] != 1 or pd[13:45] != payer.pub:
            raise SystemExit("the payer is not this program's upgrade authority; upgrade it with `opeq.py upgrade` through the admin vault")
        print("upgraded", upgrade(rpc, payer, elf, pk(args.program)))


if __name__ == "__main__":
    sys.exit(main())
