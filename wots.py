import hashlib
import json
import os
import struct

N = 16
W = 256
MSG_CHAINS = N
CSUM_CHAINS = 2
CHAINS = MSG_CHAINS + CSUM_CHAINS
HEIGHT = 10
LEAVES = 1 << HEIGHT
SIG_LEN = CHAINS * N
PATH_LEN = HEIGHT * N

T_CHAIN = 0
T_LEAF = 1
T_NODE = 2
T_PRF = 3


def adrs(kind, a, b, idx):
    return struct.pack("<BBBBI", kind, a, b, 0, idx)


def sha(*parts):
    return hashlib.sha256(b"".join(parts)).digest()


def prf(sk_seed, leaf, chain):
    return sha(sk_seed, adrs(T_PRF, chain, 0, leaf))[:N]


def f(pub_seed, leaf, chain, pos, x):
    return sha(pub_seed, adrs(T_CHAIN, chain, pos, leaf), x)[:N]


def chain_run(pub_seed, leaf, chain, x, start, steps):
    for pos in range(start, start + steps):
        x = f(pub_seed, leaf, chain, pos, x)
    return x


def leaf_compress(pub_seed, leaf, pks):
    return sha(pub_seed, adrs(T_LEAF, 0, 0, leaf), *pks)[:N]


def node(pub_seed, height, index, left, right):
    return sha(pub_seed, adrs(T_NODE, height, 0, index), left, right)[:N]


def digits(digest16):
    d = list(digest16)
    csum = sum(W - 1 - x for x in d)
    return d + [csum >> 8, csum & 0xFF]


def leaf_pk(sk_seed, pub_seed, leaf):
    pks = [chain_run(pub_seed, leaf, c, prf(sk_seed, leaf, c), 0, W - 1) for c in range(CHAINS)]
    return leaf_compress(pub_seed, leaf, pks)


def build_tree(pub_seed, leaves):
    levels = [list(leaves)]
    for h in range(HEIGHT):
        prev = levels[-1]
        levels.append([node(pub_seed, h + 1, i, prev[2 * i], prev[2 * i + 1]) for i in range(len(prev) // 2)])
    return levels


def auth_path(levels, leaf):
    path = []
    for h in range(HEIGHT):
        path.append(levels[h][(leaf >> h) ^ 1])
    return path


def root_from_path(pub_seed, leaf, lf, path):
    x = lf
    for h in range(HEIGHT):
        idx = leaf >> (h + 1)
        if (leaf >> h) & 1:
            x = node(pub_seed, h + 1, idx, path[h], x)
        else:
            x = node(pub_seed, h + 1, idx, x, path[h])
    return x


def wots_sign(sk_seed, pub_seed, leaf, digest16):
    return [chain_run(pub_seed, leaf, c, prf(sk_seed, leaf, c), 0, d) for c, d in enumerate(digits(digest16))]


def wots_pk_from_sig(pub_seed, leaf, digest16, sig):
    return [chain_run(pub_seed, leaf, c, s, d, W - 1 - d) for c, (s, d) in enumerate(zip(sig, digits(digest16)))]


def verify(pub_seed, root, leaf, digest16, sig, path):
    pks = wots_pk_from_sig(pub_seed, leaf, digest16, sig)
    return root_from_path(pub_seed, leaf, leaf_compress(pub_seed, leaf, pks), path) == root


class TreeKey:
    def __init__(self, sk_seed, pub_seed, leaves):
        self.sk_seed = sk_seed
        self.pub_seed = pub_seed
        self.levels = build_tree(pub_seed, leaves)
        self.root = self.levels[-1][0]

    @staticmethod
    def generate(sk_seed=None, pub_seed=None):
        sk_seed = sk_seed or os.urandom(32)
        pub_seed = pub_seed or os.urandom(N)
        leaves = [leaf_pk(sk_seed, pub_seed, i) for i in range(LEAVES)]
        return TreeKey(sk_seed, pub_seed, leaves)

    def sign(self, leaf, digest16):
        sig = wots_sign(self.sk_seed, self.pub_seed, leaf, digest16)
        return b"".join(sig), b"".join(auth_path(self.levels, leaf))

    def to_json(self):
        return {
            "sk_seed": self.sk_seed.hex(),
            "pub_seed": self.pub_seed.hex(),
            "leaves": b"".join(self.levels[0]).hex(),
        }

    @staticmethod
    def from_json(d):
        raw = bytes.fromhex(d["leaves"])
        leaves = [raw[i:i + N] for i in range(0, len(raw), N)]
        return TreeKey(bytes.fromhex(d["sk_seed"]), bytes.fromhex(d["pub_seed"]), leaves)


def split(blob, size):
    return [blob[i:i + size] for i in range(0, len(blob), size)]


def verify_blob(pub_seed, root, leaf, digest16, sig_blob, path_blob):
    if len(sig_blob) != SIG_LEN or len(path_blob) != PATH_LEN or not 0 <= leaf < LEAVES:
        return False
    return verify(pub_seed, root, leaf, digest16, split(sig_blob, N), split(path_blob, N))


def save_key(path, key, extra):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({**key.to_json(), **extra}, fh)
