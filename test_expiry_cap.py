import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import emu
import program
import protocol as P
import refmodel as R
import wots
from test_emu import World, check, snapshot

ELF = program.build().elf()


def both(w, data):
    ref = snapshot(w.exec_accounts())
    ref[0]["owner"] = w.prog
    try:
        R.process(w.prog, ref, data, w.slot)
        want = 0
    except R.Reject as e:
        want = e.code
    before = snapshot(w.exec_accounts())
    try:
        got, _ = w.run(w.exec_accounts(), data)
    except emu.Fault as e:
        got = f"fault:{e}"
    if got != 0:
        for a, b in zip(w.exec_accounts(), before):
            a.update(b)
    return got, want


def fresh():
    w = World(ELF)
    rc, _ = w.init()
    assert rc == 0, f"init failed rc={rc}"
    w.wallet["lamports"] = 10**9
    return w


w = fresh()
win = P.MAX_EXPIRY_WINDOW
cases = [
    ("exec expiry = slot + window (edge, allowed)", w.slot + win, 0),
    ("exec expiry = slot + window + 1 (rejected 23)", w.slot + win + 1, 23),
    ("exec expiry = u64 max (non-expiring blob rejected 23)", (1 << 64) - 1, 23),
    ("exec expiry = slot (allowed, expires now)", w.slot, 0),
    ("exec expiry = slot - 1 (already expired, 6)", w.slot - 1, 6),
]
leaf = 0
for name, expiry, want_rc in cases:
    got, want = both(w, w.signed_exec(leaf, expiry, w.transfer_inner(1000)))
    check(f"{name}: program={got} model={want}", got == want == want_rc)
    if got == 0:
        leaf += 1

w2 = fresh()
new = wots.TreeKey.generate()
got, want = both(w2, w2.signed_rekey(0, new, expiry=w2.slot + win + 1))
check(f"rekey expiry past window rejected: program={got} model={want}", got == want == 23)
got, want = both(w2, w2.signed_rekey(0, new, expiry=w2.slot + win))
check(f"rekey expiry at window allowed: program={got} model={want}", got == want == 0)

print("ALL PASSED" if check.failed == 0 else f"FAILED {check.failed}")
sys.exit(1 if check.failed else 0)
