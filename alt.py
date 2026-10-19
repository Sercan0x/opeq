import argparse
import base64
import struct
import sys
import time

from deploy import GENESIS, NETS, confirm_typed
from solkit import Rpc, find_pda_bump, load_keypair, pk, ps, u32, u64

ALT = pk("AddressLookupTab1e1111111111111111111111111")
SYSTEM = pk("11111111111111111111111111111111")
SWAP_KEYS = [
    "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf",
    "Sysvar1nstructions1111111111111111111111111",
    "So11111111111111111111111111111111111111112",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "9tpHqTJ2d8jMZJjZzsf9MCfnCEmbAjsqjPJ56PzSpump",
]


def table_state(rpc, table):
    acc = rpc.account(table)
    if acc is None:
        return None
    d = bytes(acc["data"])
    if acc["owner"] != ALT:
        raise SystemExit("that account is not an address lookup table")
    auth = d[22:54] if d[21] == 1 else None
    return {"authority": auth, "addresses": [ps(d[o:o + 32]) for o in range(56, len(d), 32)]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["create", "show"])
    ap.add_argument("--net", default="devnet", choices=list(NETS))
    ap.add_argument("--rpc")
    ap.add_argument("--key")
    ap.add_argument("--table")
    args = ap.parse_args()
    rpc = Rpc(args.rpc or NETS[args.net])
    if rpc.call("getGenesisHash") != GENESIS[args.net]:
        raise SystemExit(f"the RPC is not {args.net}")
    if args.cmd == "show":
        st = table_state(rpc, pk(args.table))
        print("frozen" if st["authority"] is None else f"authority {ps(st['authority'])}")
        for a in st["addresses"]:
            print(" ", a)
        return
    if not args.key:
        raise SystemExit("pass --key <payer keypair file>")
    payer = load_keypair(args.key)
    slot = rpc.call("getSlot", [{"commitment": "finalized"}])
    table, bump = find_pda_bump([payer.pub, u64(slot)], ALT)
    print(f"network {args.net}\npayer {ps(payer.pub)}\ntable {ps(table)}\naddresses {len(SWAP_KEYS)}, then frozen forever")
    confirm_typed("the table cannot be changed or closed after it is frozen", "FREEZE")
    meta = [(table, False, True), (payer.pub, True, False), (payer.pub, True, True), (SYSTEM, False, False)]
    print("created", rpc.send([(ALT, meta, u32(0) + u64(slot) + bytes([bump]))], [payer]))
    keys = b"".join(pk(k) for k in SWAP_KEYS)
    print("extended", rpc.send([(ALT, meta, u32(2) + u64(len(SWAP_KEYS)) + keys)], [payer]))
    print("frozen", rpc.send([(ALT, [(table, False, True), (payer.pub, True, False)], u32(1))], [payer]))
    time.sleep(2)
    st = table_state(rpc, table)
    if st["authority"] is not None or st["addresses"] != SWAP_KEYS:
        raise SystemExit("table contents or authority differ from what was sent, check it")
    print("verified: frozen,", len(st["addresses"]), "addresses, table", ps(table))


if __name__ == "__main__":
    sys.exit(main())
