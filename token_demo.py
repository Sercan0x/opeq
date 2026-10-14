import argparse
import json
import os
import struct

import opeq
from solkit import Keypair, Rpc, find_pda, load_keypair, pk, ps, u8, u32, u64

HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEM = pk("11111111111111111111111111111111")
ATA_PROG = pk("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
TOKEN_PROGS = {"spl": pk("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), "t22": pk("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")}
DECIMALS = 6
MINT_LEN = 82


def ata(owner, mint, tprog):
    return find_pda([owner, tprog, mint], ATA_PROG)


def ix_create_ata(payer, owner, mint, tprog):
    return (ATA_PROG, [(payer, True, True), (ata(owner, mint, tprog), False, True), (owner, False, False),
                       (mint, False, False), (SYSTEM, False, False), (tprog, False, False)], u8(1))


def ix_transfer_checked(tprog, src, mint, dst, authority, amount):
    return (tprog, [(src, False, True), (mint, False, False), (dst, False, True), (authority, True, False)],
            u8(12) + u64(amount) + u8(DECIMALS))


def token_balance(rpc, acct):
    try:
        return int(rpc.call("getTokenAccountBalance", [ps(acct), {"commitment": "confirmed"}])["value"]["amount"])
    except Exception:
        return None


def setup(rpc, payer, v, kind, state_path):
    tprog = TOKEN_PROGS[kind]
    mint = Keypair.generate()
    rpc.send([
        (SYSTEM, [(payer.pub, True, True), (mint.pub, True, True)], u32(0) + u64(rpc.rent(MINT_LEN)) + u64(MINT_LEN) + tprog),
        (tprog, [(mint.pub, False, True)], u8(20) + u8(DECIMALS) + payer.pub + u8(0)),
    ], [payer, mint])
    vault_ata = ata(v.wallet, mint.pub, tprog)
    rpc.send([
        ix_create_ata(payer.pub, v.wallet, mint.pub, tprog),
        (tprog, [(mint.pub, False, True), (vault_ata, False, True), (payer.pub, True, False)], u8(7) + u64(1_000_000 * 10**DECIMALS)),
    ], [payer])
    json.dump({"mint": ps(mint.pub)}, open(state_path, "w"))
    print(f"[{kind}] mint {ps(mint.pub)}, minted 1,000,000 to quantum wallet ATA {ps(vault_ata)}")
    return mint.pub


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", default="spl", choices=list(TOKEN_PROGS))
    ap.add_argument("--to")
    ap.add_argument("--amount", type=float, default=1234.5)
    ap.add_argument("--vault", default=os.path.join(HERE, "vault.json"))
    ap.add_argument("--payer", default=os.path.join(HERE, "devnet-key.json"))
    args = ap.parse_args()
    rpc = Rpc(opeq.NETS["devnet"])
    payer = load_keypair(args.payer)
    v = opeq.Vault(args.vault)
    tprog = TOKEN_PROGS[args.kind]
    state_path = os.path.join(HERE, f"demo-mint-{args.kind}.json")
    mint = pk(json.load(open(state_path))["mint"]) if os.path.exists(state_path) else setup(rpc, payer, v, args.kind, state_path)
    to = pk(args.to) if args.to else Keypair.generate().pub
    src = ata(v.wallet, mint, tprog)
    dst = ata(to, mint, tprog)
    amount = int(round(args.amount * 10**DECIMALS))
    inner = [
        ix_create_ata(v.wallet, to, mint, tprog),
        ix_transfer_checked(tprog, src, mint, dst, v.wallet, amount),
    ]
    sol_before = rpc.balance(v.wallet)
    sig = opeq.send_exec(rpc, payer, v, inner, cu_limit=600_000)
    print("tx", sig)
    tx = rpc.call("getTransaction", [sig, {"commitment": "confirmed", "maxSupportedTransactionVersion": 0}])
    for line in tx["meta"]["logMessages"]:
        if "invoke" in line or "consumed" in line or "Instruction:" in line:
            print("  ", line)
    print(f"recipient {ps(to)} now holds {token_balance(rpc, dst) / 10**DECIMALS} tokens")
    print(f"quantum wallet holds {token_balance(rpc, src) / 10**DECIMALS} tokens, paid {(sol_before - rpc.balance(v.wallet)) / 1e9} SOL rent for the new account")


if __name__ == "__main__":
    main()
