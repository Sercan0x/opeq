import { execFileSync } from "node:child_process";
import * as V from "../lib/solvault.js";
import { hex, unhex, SYSTEM } from "../lib/solana.js";
import { sha256 } from "../lib/sha256.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const enc = new TextEncoder();
const prog = sha256(enc.encode("vault program")), opeq = sha256(enc.encode("opeq program"));
const people = [0, 1, 2].map((i) => V.ownerFromId(sha256(enc.encode("aid" + i)), opeq));
const nonce = sha256(enc.encode("nonce"));
const ms = V.msPda(people[0].wallet, nonce, prog), vault = V.vaultPda(ms.key, prog), p7 = V.proposalPda(ms.key, 7, prog);
const bob = sha256(enc.encode("bob"));
const pay = [[SYSTEM, [[vault.key, V.M_SIGNER | V.M_WRITABLE], [bob, V.M_WRITABLE]], Uint8Array.of(2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0)]];
const stored = V.encodeStored(pay);
const js = {
  wallets: people.map((p) => hex(p.wallet) + ":" + p.wbump),
  ms: hex(ms.key) + ":" + ms.bump, vault: hex(vault.key) + ":" + vault.bump, p7: hex(p7.key) + ":" + p7.bump,
  create: hex(V.createIx(prog, people[0].wallet, ms.key, nonce, 2, people)[2]),
  stored: hex(stored),
  propose: hex(V.proposeIx(prog, people[0].wallet, ms.key, p7.key, 1800003600, stored)[2]),
  approve: hex(V.voteIx(prog, V.IX_APPROVE, people[0].wallet, ms.key, p7.key, 7, sha256(stored))[2]),
  owners: hex(V.setOwnersData(1, people.slice(0, 2))),
};
const py = JSON.parse(execFileSync("python3", ["-c", `
import hashlib, json, struct, sys
sys.path.insert(0, ".")
import msig_protocol as M
from solkit import find_pda_bump
H = lambda s: hashlib.sha256(s).digest()
prog, opeq = H(b"vault program"), H(b"opeq program")
ppl = []
for i in range(3):
    aid = H(b"aid%d" % i)
    k, b = find_pda_bump([b"w", aid], opeq)
    ppl.append((aid, b, k))
nonce = H(b"nonce")
ms, mb = M.ms_pda(ppl[0][2], nonce, prog)
v, vb = M.vault_pda(ms, prog)
p7, pb = M.proposal_pda(ms, 7, prog)
bob = H(b"bob")
stored = M.encode_stored([(bytes(32), [(v, 3), (bob, 2)], struct.pack("<IQ", 2, 10**9))])
print(json.dumps({
 "wallets": [k.hex() + ":" + str(b) for a, b, k in ppl],
 "ms": ms.hex() + ":" + str(mb), "vault": v.hex() + ":" + str(vb), "p7": p7.hex() + ":" + str(pb),
 "create": M.build_create(nonce, 2, [(a, b) for a, b, k in ppl]).hex(),
 "stored": stored.hex(),
 "propose": M.build_propose(1800003600, stored).hex(),
 "approve": M.build_vote(M.IX_APPROVE, 7, hashlib.sha256(stored).digest()).hex(),
 "owners": M.set_owners_data(1, [(a, b) for a, b, k in ppl[:2]]).hex(),
}))
`], { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" }));
for (const k of Object.keys(py)) ok(JSON.stringify(js[k]) === JSON.stringify(py[k]), `${k} matches the program protocol`);

let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const cases = [];
for (let i = 0; i < 2000; i++) {
  const b = Uint8Array.from(V.encodeStored(rnd(3) ? pay : [...pay, ...pay]));
  for (let j = 0; j <= rnd(3); j++) b[rnd(b.length)] = rnd(256);
  cases.push(hex(rnd(5) ? b : b.slice(0, rnd(b.length + 1))));
}
const codes = JSON.parse(execFileSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ".")
import msig_ref as R
v = bytes.fromhex(sys.argv[1])
out = []
for h in json.load(sys.stdin):
    try:
        R.Run(None, None, [], b"", 0, None).check_stored(bytes.fromhex(h), v); out.append(0)
    except R.Reject as e:
        out.append(e.code)
print(json.dumps(out))
`, hex(vault.key)], { cwd: new URL("../..", import.meta.url).pathname, input: JSON.stringify(cases), encoding: "utf8" }));
let same = 0;
cases.forEach((h, i) => { let c = 0; try { V.decodeStored(h ? unhex(h) : new Uint8Array(0), vault.key); } catch (e) { c = e.code; } if (c === codes[i]) same++; else if (same < 3) console.log("diff", h.slice(0, 40), "js", c, "py", codes[i]); });
ok(same === cases.length, `decoder agrees with the program on ${same}/${cases.length} random stored-instruction buffers`);

const d = V.describe(V.decodeStored(stored, vault.key)[0], { program: prog, opeqProgram: opeq, vault: vault.key });
ok(d.kind === "pay" && d.lamports === 1000000000n && hex(d.to) === hex(bob), "SOL payment described");
const own = V.describe([prog, [], V.setOwnersData(1, people.slice(0, 2))], { program: prog, opeqProgram: opeq, vault: vault.key });
ok(own.kind === "owners" && own.wallets.map(hex).join() === people.slice(0, 2).map((p) => hex(p.wallet)).join(), "owner change described with wallet addresses");
const smuggle = V.describe([prog, [], new Uint8Array([...V.setOwnersData(1, people.slice(0, 2)), 0])], { program: prog, opeqProgram: opeq, vault: vault.key });
ok(smuggle.kind === "contract", "non-canonical owner change is not described as an owner list");
console.log(fail ? `${fail} FAILED` : `ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
