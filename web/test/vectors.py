import hashlib
import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

import mnemonic
import protocol as P
import wots
from solkit import b58encode, find_pda_bump

master = bytes(range(32))
tree = mnemonic.tree(master, 0, mnemonic.LEGACY_PROGRAM)
tree1 = mnemonic.tree(master, 1, mnemonic.LEGACY_PROGRAM)
program = hashlib.sha256(b"opeq test program").digest()
v2sk0, v2pub0 = mnemonic.tree_seeds(master, 0, program)
v3seed = bytes(range(100, 116))
v2sk1, v2pub1 = mnemonic.tree_seeds(master, 1, program, v3seed)
aid = P.account_id(tree.pub_seed, tree.root)
state, sbump = P.state_pda(aid, program)
wallet, wbump = P.wallet_pda(aid, program)
r = bytes(range(100, 116))
inner = [(bytes(32), [(wallet, True, True), (hashlib.sha256(b"bob").digest(), False, True)], struct.pack("<IQ", 2, 12345))]
hasher = P.exec_hasher(program, aid, 1, 5, 999, inner, r=r)
salt, digest, cost = P.grind(hasher, 4096)
sig, path = tree.sign(5, digest)
keys = [state, wallet, bytes(32), hashlib.sha256(b"bob").digest()]
data = P.build_exec(5, 999, salt, r, sig, path, inner, keys)
rk_hasher = P.rekey_hasher(program, aid, 0, 7, 555, tree1.pub_seed, tree1.root, r=r)
rk_salt, rk_digest, _ = P.grind(rk_hasher, 512)
rk_sig, rk_path = tree.sign(7, rk_digest)

out = {
    "sha_empty": hashlib.sha256(b"").hexdigest(),
    "sha_abc": hashlib.sha256(b"abc").hexdigest(),
    "sha_long": hashlib.sha256(bytes(range(256)) * 5).hexdigest(),
    "master": master.hex(),
    "words": " ".join(mnemonic.to_words(master)),
    "sk0": tree.sk_seed.hex(), "pub0": tree.pub_seed.hex(), "root0": tree.root.hex(),
    "v2_sk0": v2sk0.hex(), "v2_pub0": v2pub0.hex(), "v2_sk1": v2sk1.hex(), "v2_pub1": v2pub1.hex(),
    "root1": tree1.root.hex(), "pub1": tree1.pub_seed.hex(),
    "leaf5": tree.levels[0][5].hex(),
    "program": program.hex(), "program_b58": b58encode(program),
    "aid": aid.hex(), "state": b58encode(state), "sbump": sbump, "wallet": b58encode(wallet), "wbump": wbump,
    "r": r.hex(), "salt": salt, "digest": digest.hex(), "cost": cost,
    "sig": sig.hex(), "path": path.hex(), "exec_data": data.hex(),
    "rk_salt": rk_salt, "rk_digest": rk_digest.hex(), "rk_data": P.build_rekey(7, 555, rk_salt, r, rk_sig, rk_path, tree1.pub_seed, tree1.root).hex(),
    "init_data": P.build_init(tree.pub_seed, tree.root, 1500000).hex(),
}
print(json.dumps(out))
