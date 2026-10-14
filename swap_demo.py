import argparse
import json
import os
import struct
import sys

import opeq
import v0
from solkit import Rpc, anchor_disc, find_pda, load_keypair, pk, ps, u8, u64
from token_demo import ATA_PROG, DECIMALS, SYSTEM, TOKEN_PROGS, ata, ix_create_ata

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = TOKEN_PROGS["spl"]
WSOL = pk("So11111111111111111111111111111111111111112")
RENT = pk("SysvarRent111111111111111111111111111111111")
CPMM = pk("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb")
POOL_FEE = pk("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy")
STATE = os.path.join(HERE, "demo-swap.json")


def amm_config(rpc, index):
    for fmt in (">H", "<H"):
        key = find_pda([b"amm_config", struct.pack(fmt, index)], CPMM)
        acc = rpc.account(key)
        if acc and acc["owner"] == CPMM:
            trade, = struct.unpack_from("<Q", acc["data"], 12)
            return key, trade
    sys.exit(f"amm config {index} not found")


def pool_keys(cfg, mint):
    m0, m1 = (WSOL, mint) if WSOL < mint else (mint, WSOL)
    pool = find_pda([b"pool", cfg, m0, m1], CPMM)
    return {"m0": m0, "m1": m1, "pool": pool, "auth": find_pda([b"vault_and_lp_mint_auth_seed"], CPMM),
            "lp": find_pda([b"pool_lp_mint", pool], CPMM), "v0": find_pda([b"pool_vault", pool, m0], CPMM),
            "v1": find_pda([b"pool_vault", pool, m1], CPMM), "obs": find_pda([b"observation", pool], CPMM)}


def amount_of(rpc, acct):
    return int(rpc.call("getTokenAccountBalance", [ps(acct), {"commitment": "confirmed"}])["value"]["amount"])


def setup(rpc, payer, v, mint):
    cfg, trade = amm_config(rpc, 0)
    k = pool_keys(cfg, mint)
    me = payer.pub
    my_tok, my_wsol = ata(me, mint, TOKEN), ata(me, WSOL, TOKEN)
    tok_raw, sol_raw = 500_000 * 10**DECIMALS, 1_000_000_000
    rpc.send([
        ix_create_ata(me, me, mint, TOKEN),
        (TOKEN, [(mint, False, True), (my_tok, False, True), (me, True, False)], u8(7) + u64(tok_raw)),
    ], [payer])
    a0, a1, c0, c1 = (sol_raw, tok_raw, my_wsol, my_tok) if k["m0"] == WSOL else (tok_raw, sol_raw, my_tok, my_wsol)
    rpc.send([
        ix_create_ata(me, me, WSOL, TOKEN),
        (SYSTEM, [(me, True, True), (my_wsol, False, True)], struct.pack("<IQ", 2, sol_raw)),
        (TOKEN, [(my_wsol, False, True)], u8(17)),
        (CPMM, [
            (me, True, True), (cfg, False, False), (k["auth"], False, False), (k["pool"], False, True),
            (k["m0"], False, False), (k["m1"], False, False), (k["lp"], False, True),
            (c0, False, True), (c1, False, True), (ata(me, k["lp"], TOKEN), False, True),
            (k["v0"], False, True), (k["v1"], False, True), (POOL_FEE, False, True),
            (k["obs"], False, True), (TOKEN, False, False), (TOKEN, False, False), (TOKEN, False, False),
            (ATA_PROG, False, False), (SYSTEM, False, False), (RENT, False, False),
        ], anchor_disc("initialize") + u64(a0) + u64(a1) + u64(0)),
        (TOKEN, [(my_wsol, False, True), (me, False, True), (me, True, False)], u8(9)),
    ], [payer], cu_limit=400_000)
    print(f"pool {ps(k['pool'])}: 1 SOL + 500,000 tokens, trade fee {trade / 10000}%")
    addrs = [v.state, v.wallet, ATA_PROG, SYSTEM, TOKEN, CPMM, k["auth"], cfg, k["pool"],
             ata(v.wallet, mint, TOKEN), ata(v.wallet, WSOL, TOKEN), k["v0"], k["v1"], mint, WSOL, k["obs"]]
    table = v0.create_table(rpc, payer, addrs)
    print(f"lookup table {ps(table)} with {len(addrs)} addresses")
    json.dump({"mint": ps(mint), "cfg": ps(cfg), "trade": trade, "table": ps(table)}, open(STATE, "w"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokens", type=float, default=10_000)
    ap.add_argument("--slippage-bps", type=int, default=100)
    ap.add_argument("--vault", default=os.path.join(HERE, "vault.json"))
    ap.add_argument("--payer", default=os.path.join(HERE, "devnet-key.json"))
    args = ap.parse_args()
    rpc = Rpc(opeq.NETS["devnet"])
    payer = load_keypair(args.payer)
    v = opeq.Vault(args.vault)
    mint = pk(json.load(open(os.path.join(HERE, "demo-mint-spl.json")))["mint"])
    if not os.path.exists(STATE):
        setup(rpc, payer, v, mint)
    st = json.load(open(STATE))
    cfg, table = pk(st["cfg"]), pk(st["table"])
    k = pool_keys(cfg, mint)
    vin, vout = (k["v1"], k["v0"]) if k["m0"] == WSOL else (k["v0"], k["v1"])
    r_in, r_out = amount_of(rpc, vin), amount_of(rpc, vout)
    amount_in = int(args.tokens * 10**DECIMALS)
    after_fee = amount_in * (1_000_000 - st["trade"]) // 1_000_000
    expected = r_out * after_fee // (r_in + after_fee)
    min_out = expected * (10_000 - args.slippage_bps) // 10_000
    src, wsol = ata(v.wallet, mint, TOKEN), ata(v.wallet, WSOL, TOKEN)
    inner = [
        ix_create_ata(v.wallet, v.wallet, WSOL, TOKEN),
        (CPMM, [
            (v.wallet, True, False), (k["auth"], False, False), (cfg, False, False), (k["pool"], False, True),
            (src, False, True), (wsol, False, True), (vin, False, True), (vout, False, True),
            (TOKEN, False, False), (TOKEN, False, False), (mint, False, False), (WSOL, False, False),
            (k["obs"], False, True),
        ], anchor_disc("swap_base_input") + u64(amount_in) + u64(min_out)),
        (TOKEN, [(wsol, False, True), (v.wallet, False, True), (v.wallet, True, False)], u8(9)),
    ]
    tok0, sol0 = amount_of(rpc, src), rpc.balance(v.wallet)
    print(f"swapping {args.tokens:,} tokens -> SOL, expect {expected / 1e9:.6f} SOL, min {min_out / 1e9:.6f}")
    sig = opeq.send_exec(rpc, payer, v, inner, cu_limit=700_000, tables={table: v0.read_table(rpc, table)})
    print("tx", sig)
    tx = rpc.call("getTransaction", [sig, {"commitment": "confirmed", "maxSupportedTransactionVersion": 0}])
    for line in tx["meta"]["logMessages"]:
        if "invoke [" in line or "consumed" in line or "Instruction:" in line:
            print("  ", line)
    tok1, sol1 = amount_of(rpc, src), rpc.balance(v.wallet)
    print(f"quantum wallet: tokens {tok0 / 10**DECIMALS:,} -> {tok1 / 10**DECIMALS:,}, SOL {sol0 / 1e9:.6f} -> {sol1 / 1e9:.6f}")


if __name__ == "__main__":
    main()
