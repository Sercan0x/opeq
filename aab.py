import base64
import datetime
import hashlib
import os

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs7

import apk
from axml import ANDROID, ATTR, Hex, Ref

BUNDLETOOL_VERSION = "1.17.2"
FILE_PNG = 1
FILE_PROTO_XML = 3
SIGNER = "UPLOAD"


def varint(n):
    if n < 0:
        n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7f
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def msg(num, body):
    return varint(num << 3 | 2) + varint(len(body)) + body


def text(num, s):
    return msg(num, s.encode())


def num(num_, n, keep_zero=False):
    if n == 0 and not keep_zero:
        return b""
    return varint(num_ << 3) + varint(int(n))


def xml_node(e, names, root=True):
    attrs = b""
    for name, value in e.attrs:
        if name.startswith("android:"):
            short = name[8:]
            head = text(1, ANDROID) + text(2, short)
            rid = ATTR[short]
        else:
            head = text(2, name)
            rid = 0
        if isinstance(value, bool):
            shown, item = ("true" if value else "false"), msg(7, num(8, 1 if value else 0, True))
        elif isinstance(value, Ref):
            shown = "@" + names[int(value)]
            item = msg(1, num(2, int(value)) + text(3, names[int(value)]))
        elif isinstance(value, Hex):
            shown, item = hex(int(value)), msg(7, num(7, int(value), True))
        elif isinstance(value, int):
            shown, item = str(value), msg(7, num(6, value, True))
        else:
            shown, item = value, b""
        a = head + text(3, shown) + num(5, rid)
        if item:
            a += msg(6, item)
        attrs += msg(4, a)
    ns = msg(1, text(1, "android") + text(2, ANDROID)) if root else b""
    body = ns + text(3, e.tag) + attrs + b"".join(msg(5, xml_node(c, names, False)) for c in e.children)
    return msg(1, body)


def resource_table(package, package_id, types, kinds):
    out = b""
    for t_index, (t_name, entries) in enumerate(types, start=1):
        ents = b""
        for e_index, (key, path) in enumerate(entries):
            ref = text(1, path) + num(2, kinds[path])
            value = msg(4, msg(5, ref))
            config = msg(1, b"") + msg(2, value)
            ents += msg(3, msg(1, num(1, e_index)) + text(2, key) + msg(6, config))
        out += msg(3, msg(1, num(1, t_index)) + text(2, t_name) + ents)
    return msg(2, msg(1, num(1, package_id)) + text(2, package) + out)


def bundle_config():
    return msg(1, text(2, BUNDLETOOL_VERSION))


def mf_line(s):
    b = s.encode()
    parts = [b[:72]]
    b = b[72:]
    while b:
        parts.append(b" " + b[:71])
        b = b[71:]
    return b"\r\n".join(parts) + b"\r\n"


def b64sha(b):
    return base64.b64encode(hashlib.sha256(b).digest()).decode()


def jar_sign(files, key, cert):
    head = mf_line("Manifest-Version: 1.0") + mf_line("Created-By: 1.0 (OPEQ)") + b"\r\n"
    sections = []
    for n, d in files:
        sections.append((n, mf_line("Name: " + n) + mf_line("SHA-256-Digest: " + b64sha(d)) + b"\r\n"))
    mf = head + b"".join(sec for _, sec in sections)
    sf = (mf_line("Signature-Version: 1.0") + mf_line("Created-By: 1.0 (OPEQ)")
          + mf_line("SHA-256-Digest-Manifest: " + b64sha(mf))
          + mf_line("SHA-256-Digest-Manifest-Main-Attributes: " + b64sha(head)) + b"\r\n")
    for n, sec in sections:
        sf += mf_line("Name: " + n) + mf_line("SHA-256-Digest: " + b64sha(sec)) + b"\r\n"
    block = (pkcs7.PKCS7SignatureBuilder().set_data(sf).add_signer(cert, key, hashes.SHA256())
             .sign(serialization.Encoding.DER, [pkcs7.PKCS7Options.DetachedSignature,
                                                pkcs7.PKCS7Options.NoCapabilities]))
    return [("META-INF/MANIFEST.MF", mf), (f"META-INF/{SIGNER}.SF", sf), (f"META-INF/{SIGNER}.RSA", block)]


def jar_check(entries):
    mf = entries["META-INF/MANIFEST.MF"]
    sf = entries[f"META-INF/{SIGNER}.SF"]
    want = {}
    for sec in mf.split(b"\r\n\r\n")[1:]:
        if not sec:
            continue
        lines = sec.replace(b"\r\n ", b"").split(b"\r\n")
        fields = dict(l.decode().split(": ", 1) for l in lines if l)
        want[fields["Name"]] = fields["SHA-256-Digest"]
    signed = {n for n in entries if not n.startswith("META-INF/")}
    if set(want) != signed:
        raise ValueError("the manifest does not list exactly the bundle files")
    for n, d in want.items():
        if b64sha(entries[n]) != d:
            raise ValueError(f"digest mismatch for {n}")
    if f"SHA-256-Digest-Manifest: {b64sha(mf)}".encode() not in sf.replace(b"\r\n ", b""):
        raise ValueError("the signature file does not match the manifest")
    return True


def load_key(path):
    with open(path, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), None)
    with open(path + ".crt", "rb") as f:
        cert = x509.load_pem_x509_certificate(f.read())
    if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 2048:
        raise SystemExit("the Play upload key must be RSA, 2048 bits or more")
    if cert.public_key().public_numbers() != key.public_key().public_numbers():
        raise SystemExit("the certificate does not match the upload key")
    return key, cert


def new_key(path, common_name):
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
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


def build(manifest_el, names, dex, table_types, kinds, res_files, xml_files, assets, package, key, cert):
    files = [("BundleConfig.pb", bundle_config()),
             ("base/manifest/AndroidManifest.xml", xml_node(manifest_el, names)),
             ("base/dex/classes.dex", dex),
             ("base/resources.pb", resource_table(package, 0x7f, table_types, kinds))]
    files += [("base/" + n, d) for n, d in res_files.items()]
    files += [("base/" + n, xml_node(e, names)) for n, e in xml_files.items()]
    files += [("base/" + n, d) for n, d in assets]
    files = jar_sign(files, key, cert) + files
    body, central, eocd = apk.zip_entries(files)
    return body + central + eocd
