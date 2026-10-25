import hashlib
import struct
import zlib

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

DOS_DATE = (0 << 9) | (1 << 5) | 1
ALIGN_EXTRA = 0xd935
V2_BLOCK_ID = 0x7109871a
ECDSA_SHA256 = 0x0201
MAGIC = b"APK Sig Block 42"
CHUNK = 1 << 20


def lp(b):
    return struct.pack("<I", len(b)) + b


def zip_entries(files, stored=()):
    body = bytearray()
    central = bytearray()
    for name, data in files:
        raw = name.encode()
        crc = zlib.crc32(data)
        if name in stored:
            method, comp = 0, data
        else:
            c = zlib.compressobj(9, zlib.DEFLATED, -15)
            method, comp = 8, c.compress(data) + c.flush()
        offset = len(body)
        extra = b""
        if method == 0:
            base = offset + 30 + len(raw)
            pad = (-(base + 6)) % 4
            extra = struct.pack("<HHH", ALIGN_EXTRA, 2 + pad, 4) + b"\0" * pad
        body += struct.pack("<IHHHHHIIIHH", 0x04034b50, 20, 0x0800, method, 0, DOS_DATE, crc,
                            len(comp), len(data), len(raw), len(extra)) + raw + extra
        if method == 0:
            assert len(body) % 4 == 0
        body += comp
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014b50, 20, 20, 0x0800, method, 0, DOS_DATE, crc,
                               len(comp), len(data), len(raw), 0, 0, 0, 0, 0, offset) + raw
    eocd = struct.pack("<IHHHHIIH", 0x06054b50, 0, 0, len(files), len(files), len(central), len(body), 0)
    return bytes(body), bytes(central), eocd


def content_digest(sections):
    chunks = []
    for s in sections:
        for i in range(0, len(s), CHUNK):
            part = s[i:i + CHUNK]
            chunks.append(hashlib.sha256(b"\xa5" + struct.pack("<I", len(part)) + part).digest())
    return hashlib.sha256(b"\x5a" + struct.pack("<I", len(chunks)) + b"".join(chunks)).digest()


def load_key(path):
    with open(path, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), None)
    with open(path + ".crt", "rb") as f:
        cert = x509.load_pem_x509_certificate(f.read())
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise SystemExit("the signing key must be ECDSA P-256")
    if cert.public_key().public_numbers() != key.public_key().public_numbers():
        raise SystemExit("the certificate does not match the signing key")
    return key, cert


def new_key(path, common_name):
    import datetime
    import os
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(x509.oid.NameOID.COMMON_NAME, common_name)])
    start = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(start)
            .not_valid_after(start + datetime.timedelta(days=365 * 50)).sign(key, hashes.SHA256()))
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    with open(path + ".crt", "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def sign(body, central, eocd, key, cert):
    digest = content_digest([body, central, eocd])
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    signed = lp(lp(struct.pack("<I", ECDSA_SHA256) + lp(digest))) + lp(lp(cert_der)) + lp(b"")
    sig = key.sign(signed, ec.ECDSA(hashes.SHA256()))
    pub = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    signer = lp(signed) + lp(lp(struct.pack("<I", ECDSA_SHA256) + lp(sig))) + lp(pub)
    value = lp(lp(signer))
    pairs = struct.pack("<QI", 4 + len(value), V2_BLOCK_ID) + value
    size = len(pairs) + 8 + 16
    block = struct.pack("<Q", size) + pairs + struct.pack("<Q", size) + MAGIC
    new_eocd = bytearray(eocd)
    struct.pack_into("<I", new_eocd, 16, len(body) + len(block))
    return body + block + central + bytes(new_eocd)


def build(files, stored, key, cert):
    body, central, eocd = zip_entries(files, stored)
    return sign(body, central, eocd, key, cert)


def verify(apk):
    eocd_at = apk.rindex(b"PK\x05\x06")
    eocd = apk[eocd_at:]
    cd_size, cd_off = struct.unpack_from("<II", eocd, 12)
    if eocd_at != cd_off + cd_size:
        raise ValueError("central directory does not end at the EOCD")
    if apk[cd_off - 16:cd_off] != MAGIC:
        raise ValueError("no APK signing block")
    size = struct.unpack_from("<Q", apk, cd_off - 24)[0]
    start = cd_off - size - 8
    if struct.unpack_from("<Q", apk, start)[0] != size:
        raise ValueError("signing block sizes disagree")
    pairs = apk[start + 8:cd_off - 24]
    i = 0
    value = None
    while i < len(pairs):
        n, pid = struct.unpack_from("<QI", pairs, i)
        if pid == V2_BLOCK_ID:
            value = pairs[i + 12:i + 8 + n]
        i += 8 + n
    if value is None:
        raise ValueError("no v2 signature")

    def take(b, i):
        n = struct.unpack_from("<I", b, i)[0]
        return b[i + 4:i + 4 + n], i + 4 + n

    signers, _ = take(value, 0)
    signer, _ = take(signers, 0)
    signed, j = take(signer, 0)
    sigs, j = take(signer, j)
    pub_der, _ = take(signer, j)
    pub = serialization.load_der_public_key(pub_der)
    sig_entry, _ = take(sigs, 0)
    alg = struct.unpack_from("<I", sig_entry)[0]
    sig, _ = take(sig_entry, 4)
    if alg != ECDSA_SHA256:
        raise ValueError("unexpected signature algorithm")
    pub.verify(sig, signed, ec.ECDSA(hashes.SHA256()))
    digests, k = take(signed, 0)
    certs, _ = take(signed, k)
    d_entry, _ = take(digests, 0)
    want, _ = take(d_entry, 4)
    cert_der, _ = take(certs, 0)
    if x509.load_der_x509_certificate(cert_der).public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo) != pub_der:
        raise ValueError("certificate key differs from the signer key")
    orig_eocd = bytearray(eocd)
    struct.pack_into("<I", orig_eocd, 16, start)
    got = content_digest([apk[:start], apk[cd_off:eocd_at], bytes(orig_eocd)])
    if got != want:
        raise ValueError("content digest mismatch")
    return hashlib.sha256(cert_der).hexdigest()
