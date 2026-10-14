import getpass
import hashlib
import hmac
import json
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SCRYPT_N = 1 << 17
SCRYPT_R = 8
SCRYPT_P = 1
MAXMEM = 256 * 1024 * 1024
VAULT_AAD = b"opeq/vault/v1"


def derive(password, salt, n, r, p, dklen):
    if n > (1 << 20) or r > 32 or p > 4:
        raise SystemExit("vault kdf parameters out of range")
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=MAXMEM, dklen=dklen)


def seal(seed, password, aid):
    salt = os.urandom(16)
    nonce = os.urandom(12)
    keys = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, 64)
    ct = AESGCM(keys[:32]).encrypt(nonce, seed, aid + VAULT_AAD)
    blob = {"v": 2, "kdf": "scrypt", "n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P,
            "salt": salt.hex(), "nonce": nonce.hex(), "ct": ct.hex()}
    return blob, keys[32:]


def unlock(blob, password, aid):
    if blob.get("v") != 2:
        raise SystemExit("unknown vault encryption format")
    keys = derive(password, bytes.fromhex(blob["salt"]), blob["n"], blob["r"], blob["p"], 64)
    try:
        seed = AESGCM(keys[:32]).decrypt(bytes.fromhex(blob["nonce"]), bytes.fromhex(blob["ct"]), aid + VAULT_AAD)
    except InvalidTag:
        raise SystemExit("wrong password (or vault file was tampered with)") from None
    return seed, keys[32:]


def mac(mac_key, raw):
    body = json.dumps({k: v for k, v in raw.items() if k != "mac"}, sort_keys=True, separators=(",", ":"))
    return hmac.new(mac_key, body.encode(), hashlib.sha256).hexdigest()


def check_mac(mac_key, raw):
    if not hmac.compare_digest(raw.get("mac", ""), mac(mac_key, raw)):
        raise SystemExit("vault file integrity check failed: it was modified outside opeq, refusing to sign")


def ask_password(confirm=False):
    env = os.environ.get("OPEQ_PASSWORD")
    if env:
        return env
    pw = getpass.getpass("vault password: ")
    if confirm:
        if len(pw) < 10:
            raise SystemExit("use at least 10 characters")
        if getpass.getpass("repeat password: ") != pw:
            raise SystemExit("passwords do not match")
    return pw
