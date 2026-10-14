import base64
import struct
import time

from solkit import COMPUTE_BUDGET, RpcError, b58decode, compact, find_pda_bump, pk, ps, u8, u32, u64

ALT_PROG = pk("AddressLookupTab1e1111111111111111111111111")
SYSTEM = pk("11111111111111111111111111111111")
MAX_TX = 1232


def compile_v0(payer, ixs, blockhash, tables):
    metas = {payer: [True, True]}
    order = [payer]
    programs = set()
    for prog, accs, _ in ixs:
        for k, s, w in accs:
            if k in metas:
                metas[k][0] |= s
                metas[k][1] |= w
            else:
                metas[k] = [s, w]
                order.append(k)
        programs.add(prog)
        if prog not in metas:
            metas[prog] = [False, False]
            order.append(prog)
    where = {}
    for t, addrs in tables.items():
        for i, a in enumerate(addrs):
            where.setdefault(a, (t, i))
    static, loaded = [], []
    for k in order:
        s, w = metas[k]
        if s or k in programs or k not in where:
            static.append(k)
        else:
            loaded.append(k)
    static.sort(key=lambda k: (k != payer, not metas[k][0], not metas[k][1]))
    nsig = sum(1 for k in static if metas[k][0])
    ro_signed = sum(1 for k in static if metas[k][0] and not metas[k][1])
    ro_unsigned = sum(1 for k in static if not metas[k][0] and not metas[k][1])
    lookups = []
    loaded_w, loaded_r = [], []
    for t in tables:
        wi = [where[k][1] for k in loaded if where[k][0] == t and metas[k][1]]
        ri = [where[k][1] for k in loaded if where[k][0] == t and not metas[k][1]]
        if wi or ri:
            lookups.append((t, wi, ri))
            loaded_w += [tables[t][i] for i in wi]
            loaded_r += [tables[t][i] for i in ri]
    keys = static + loaded_w + loaded_r
    idx = {k: i for i, k in enumerate(keys)}
    out = bytearray([0x80, nsig, ro_signed, ro_unsigned])
    out += compact(len(static)) + b"".join(static) + blockhash + compact(len(ixs))
    for prog, accs, data in ixs:
        out += bytes([idx[prog]]) + compact(len(accs)) + bytes(idx[a[0]] for a in accs)
        out += compact(len(data)) + data
    out += compact(len(lookups))
    for t, wi, ri in lookups:
        out += t + compact(len(wi)) + bytes(wi) + compact(len(ri)) + bytes(ri)
    return bytes(out), static[:nsig]


def send_v0(rpc, ixs, signers, tables, cu_limit=200_000):
    ixs = [(COMPUTE_BUDGET, [], u8(2) + u32(cu_limit))] + list(ixs)
    bh = rpc.call("getLatestBlockhash", [{"commitment": "confirmed"}])["value"]
    msg, signer_keys = compile_v0(signers[0].pub, ixs, b58decode(bh["blockhash"]), tables)
    by_pub = {s.pub: s for s in signers}
    tx = compact(len(signer_keys)) + b"".join(by_pub[k].sign(msg) for k in signer_keys) + msg
    if len(tx) > MAX_TX:
        raise ValueError(f"v0 transaction too large: {len(tx)} bytes")
    raw = base64.b64encode(tx).decode()
    try:
        sig = rpc.call("sendTransaction", [raw, {"encoding": "base64", "preflightCommitment": "confirmed"}])
    except RpcError as e:
        err = e.args[0]
        logs = (err.get("data") or {}).get("logs") or []
        raise RpcError(err.get("message", str(err)) + "\n" + "\n".join(logs)) from None
    deadline = time.time() + 90
    while time.time() < deadline:
        st = rpc.call("getSignatureStatuses", [[sig]])["value"][0]
        if st:
            if st.get("err"):
                raise RpcError(f"tx {sig} failed: {st['err']}")
            if st.get("confirmationStatus") in ("confirmed", "finalized"):
                return sig, len(tx)
        time.sleep(1.5)
    raise RpcError(f"tx {sig} not confirmed in 90s")


def create_table(rpc, payer, addresses):
    slot = rpc.call("getSlot", [{"commitment": "finalized"}])
    table, bump = find_pda_bump([payer.pub, struct.pack("<Q", slot)], ALT_PROG)
    accs = [(table, False, True), (payer.pub, True, False), (payer.pub, True, True), (SYSTEM, False, False)]
    rpc.send([(ALT_PROG, accs, u32(0) + u64(slot) + u8(bump))], [payer])
    for i in range(0, len(addresses), 20):
        chunk = addresses[i:i + 20]
        rpc.send([(ALT_PROG, accs, u32(2) + u64(len(chunk)) + b"".join(chunk))], [payer])
    time.sleep(3)
    return table


def read_table(rpc, table):
    d = rpc.account(table)["data"]
    return [d[56 + 32 * i:88 + 32 * i] for i in range((len(d) - 56) // 32)]
