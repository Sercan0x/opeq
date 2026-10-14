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


def tree_seeds(master, epoch):
    e = struct.pack("<I", epoch)
    sk_seed = hashlib.sha256(b"opeq/tree/sk/v1" + master + e).digest()
    pub_seed = hashlib.sha256(b"opeq/tree/pub/v1" + master + e).digest()[:wots.N]
    return sk_seed, pub_seed


def tree(master, epoch):
    sk_seed, pub_seed = tree_seeds(master, epoch)
    return wots.TreeKey.generate(sk_seed, pub_seed)
