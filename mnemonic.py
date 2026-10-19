import hashlib
import os
import re
import struct

import wots
from wordlist import WORDS

INDEX = {w: i for i, w in enumerate(WORDS)}
ENTROPY_LEN = 32
WORD_COUNT = 24


def new_master():
    return os.urandom(ENTROPY_LEN)


def to_words(entropy):
    if len(entropy) != ENTROPY_LEN:
        raise ValueError("master seed must be 32 bytes")
    bits = int.from_bytes(entropy, "big") << 8 | hashlib.sha256(entropy).digest()[0]
    return [WORDS[(bits >> (11 * (WORD_COUNT - 1 - i))) & 0x7FF] for i in range(WORD_COUNT)]


def from_words(text):
    words = re.findall(r"[a-z]+", text.lower())
    if len(words) != WORD_COUNT:
        raise ValueError(f"expected {WORD_COUNT} words, got {len(words)}")
    bits = 0
    for w in words:
        if w not in INDEX:
            matches = [x for x in WORDS if x.startswith(w[:4])] if len(w) >= 4 else []
            if len(matches) != 1:
                raise ValueError(f"unknown word: {w}")
            w = matches[0]
        bits = bits << 11 | INDEX[w]
    entropy = (bits >> 8).to_bytes(ENTROPY_LEN, "big")
    if bits & 0xFF != hashlib.sha256(entropy).digest()[0]:
        raise ValueError("checksum mismatch: a word is wrong or out of order")
    return entropy


LEGACY_PROGRAM = bytes([44, 216, 187, 13, 164, 190, 62, 155, 179, 6, 213, 191, 6, 217, 96, 213, 232, 64, 39, 146, 16, 203, 155, 85, 10, 188, 52, 192, 39, 183, 52, 1])


def chain_seeded(program, epoch):
    return bytes(program) != LEGACY_PROGRAM and epoch > 0


def tree_seeds(master, epoch, program, pub_seed=None):
    if not isinstance(program, (bytes, bytearray)) or len(program) != 32:
        raise ValueError("tree derivation needs the 32-byte program id")
    e = struct.pack("<I", epoch)
    if chain_seeded(program, epoch):
        if not isinstance(pub_seed, (bytes, bytearray)) or len(pub_seed) != wots.N:
            raise ValueError("this key tree needs its 16-byte public seed from the chain")
        return hashlib.sha256(b"opeq/tree/sk/v3" + bytes(program) + master + e + bytes(pub_seed)).digest(), bytes(pub_seed)
    if bytes(program) == LEGACY_PROGRAM:
        sk_seed = hashlib.sha256(b"opeq/tree/sk/v1" + master + e).digest()
        pub_seed = hashlib.sha256(b"opeq/tree/pub/v1" + master + e).digest()[:wots.N]
    else:
        sk_seed = hashlib.sha256(b"opeq/tree/sk/v2" + bytes(program) + master + e).digest()
        pub_seed = hashlib.sha256(b"opeq/tree/pub/v2" + bytes(program) + master + e).digest()[:wots.N]
    return sk_seed, pub_seed


def tree(master, epoch, program, pub_seed=None):
    sk_seed, pub_seed = tree_seeds(master, epoch, program, pub_seed)
    return wots.TreeKey.generate(sk_seed, pub_seed)
