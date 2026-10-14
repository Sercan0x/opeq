import argparse
import os
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
    for off in range(0, len(elf), CHUNK):
        part = elf[off:off + CHUNK]
        rpc.send([(LOADER, [(buf.pub, False, True), (payer.pub, True, False)], u32(1) + u32(off) + u64(len(part)) + part)], [payer])
        print(f"  wrote {off + len(part)}/{len(elf)}")
    return buf


def deploy(rpc, payer, elf, prog_kp, max_len):
    buf = write_buffer(rpc, payer, elf)
    pdata = find_pda([prog_kp.pub], LOADER)
    sig = rpc.send([
        create_account(payer.pub, prog_kp.pub, rpc.rent(PROGRAM_LEN), PROGRAM_LEN, LOADER),
        (LOADER, [
            (payer.pub, True, True), (pdata, False, True), (prog_kp.pub, False, True), (buf.pub, False, True),
            (RENT, False, False), (CLOCK, False, False), (SYSTEM, False, False), (payer.pub, True, False),
        ], u32(2) + u64(max_len)),
    ], [payer, prog_kp], cu_limit=400_000)
    return sig


def upgrade(rpc, payer, elf, program):
    buf = write_buffer(rpc, payer, elf)
    pdata = find_pda([program], LOADER)
    return rpc.send([(LOADER, [
        (pdata, False, True), (program, False, True), (buf.pub, False, True), (payer.pub, False, True),
        (RENT, False, False), (CLOCK, False, False), (payer.pub, True, False),
    ], u32(3))], [payer], cu_limit=400_000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["newkey", "airdrop", "balance", "deploy", "upgrade"])
    ap.add_argument("--net", default="devnet", choices=list(NETS))
    ap.add_argument("--key", default=os.path.join(HERE, "devnet-key.json"))
    ap.add_argument("--elf")
    ap.add_argument("--program-key")
    ap.add_argument("--program")
    ap.add_argument("--max-len", type=int, default=0)
    args = ap.parse_args()
    rpc = Rpc(NETS[args.net])
    if args.cmd == "newkey":
        kp = Keypair.generate()
        kp.save(args.key)
        print(ps(kp.pub))
        return
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
    elif args.cmd == "deploy":
        elf = open(args.elf, "rb").read()
        if args.program_key and os.path.exists(args.program_key):
            prog = load_keypair(args.program_key)
            if args.net == "mainnet" and Rpc(NETS["devnet"]).account(prog.pub) is not None:
                raise SystemExit(f"refusing: program {ps(prog.pub)} already exists on devnet. A program id must never live on two clusters, "
                                 f"or signatures made on one could be replayed on the other. Use a fresh --program-key for mainnet.")
        else:
            prog = Keypair.generate()
            if args.program_key:
                prog.save(args.program_key)
        max_len = max(args.max_len, len(elf))
        print("program", ps(prog.pub), "elf", len(elf), "max_len", max_len)
        print("deployed", deploy(rpc, payer, elf, prog, max_len))
    elif args.cmd == "upgrade":
        elf = open(args.elf, "rb").read()
        print("upgraded", upgrade(rpc, payer, elf, pk(args.program)))


if __name__ == "__main__":
    sys.exit(main())
