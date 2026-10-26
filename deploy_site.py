import base64
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import sys
import urllib.error
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
BOARD = os.path.join(WEB, "lab", "board")
DIST = os.path.join(ROOT, "build", "site")
WORKER = os.path.join(ROOT, "waitlist", "worker.js")
SCHEMA = os.path.join(ROOT, "waitlist", "schema.sql")
CREDS = os.path.expanduser("~/.cloudflare-opeq")
SECRETS = os.path.expanduser("~/.opeq-waitlist-secrets")
SCRIPT = "opeq-site"
DATABASE = "opeq-waitlist"
ZONE = "opeq.io"
HOSTS = ["opeq.io", "www.opeq.io"]
API = "https://api.cloudflare.com/client/v4"
BOARD_FILES = ["index.html", "board.css", "board.js", "app.html", "app.css", "app.js", "privacy.html", "privacy.css", "privacy.js"]
SKIP_ASSETS = {".ttf"}
SKIP_LIB = {"pixelfont.js", "sprites.js", "waitlist.js"}


def read_kv(path):
    out = {}
    with open(path) as f:
        for line in f:
            line = line.strip().replace("\r", "")
            if "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


if os.path.exists(CREDS) and os.stat(CREDS).st_mode & 0o077:
    raise SystemExit(f"{CREDS} must be readable only by you: chmod 600 {CREDS}")
CRED = read_kv(CREDS)
TOKEN, ACCOUNT = CRED["TOKEN"], CRED["ACCOUNT"]


def call(method, path, body=None, raw=None, ctype=None, auth=None):
    headers = {"Authorization": f"Bearer {auth or TOKEN}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    elif raw is not None:
        data = raw
        headers["Content-Type"] = ctype
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        raise SystemExit(f"{method} {path} -> {e.code}\n{text[:1500]}")


def multipart(parts):
    boundary = "opeq" + uuid.uuid4().hex
    chunks = []
    for name, filename, ctype, content in parts:
        disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        chunks.append(f"--{boundary}\r\nContent-Disposition: {disp}\r\nContent-Type: {ctype}\r\n\r\n".encode())
        chunks.append(content if isinstance(content, bytes) else content.encode())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def build():
    shutil.rmtree(DIST, ignore_errors=True)
    os.makedirs(DIST)
    for name in BOARD_FILES:
        with open(os.path.join(BOARD, name), encoding="utf-8") as f:
            text = f.read().replace("../../", "/" if name.endswith((".html", ".css")) else "./")
        with open(os.path.join(DIST, name), "w", encoding="utf-8") as f:
            f.write(text)
    shutil.copy(os.path.join(WEB, "intro.css"), DIST)
    os.makedirs(os.path.join(DIST, "lib"))
    for n in os.listdir(os.path.join(WEB, "lib")):
        if n.endswith(".js") and n not in SKIP_LIB:
            shutil.copy(os.path.join(WEB, "lib", n), os.path.join(DIST, "lib"))
    usb = os.path.join(WEB, "usb")
    if os.path.isdir(usb):
        os.makedirs(os.path.join(DIST, "usb"))
        for n in os.listdir(usb):
            if n.endswith(".json"):
                shutil.copy(os.path.join(usb, n), os.path.join(DIST, "usb"))
    os.makedirs(os.path.join(DIST, "assets"))
    for n in os.listdir(os.path.join(WEB, "assets")):
        if os.path.splitext(n)[1] not in SKIP_ASSETS:
            shutil.copy(os.path.join(WEB, "assets", n), os.path.join(DIST, "assets"))
    files = {}
    for base, _, names in os.walk(DIST):
        for n in names:
            full = os.path.join(base, n)
            files["/" + os.path.relpath(full, DIST).replace(os.sep, "/")] = full
    return files


def database():
    found = call("GET", f"/accounts/{ACCOUNT}/d1/database?name={DATABASE}")["result"]
    found = [d for d in found if d["name"] == DATABASE]
    if found:
        db = found[0]["uuid"]
    else:
        db = call("POST", f"/accounts/{ACCOUNT}/d1/database", {"name": DATABASE})["result"]["uuid"]
        print("created D1", DATABASE)
    with open(SCHEMA) as f:
        for stmt in [s.strip() for s in f.read().split(";") if s.strip()]:
            call("POST", f"/accounts/{ACCOUNT}/d1/database/{db}/query", {"sql": stmt})
    return db


def secret_values():
    if not os.path.exists(SECRETS):
        fd = os.open(SECRETS, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"SALT={secrets.token_hex(32)}\nADMIN={secrets.token_hex(32)}\n")
        print("wrote", SECRETS)
    v = read_kv(SECRETS)
    return v["SALT"], v["ADMIN"]


def upload_assets(files):
    manifest = {}
    blobs = {}
    for path, full in files.items():
        with open(full, "rb") as f:
            data = f.read()
        h = hashlib.sha256(data + path.encode()).hexdigest()[:32]
        manifest[path] = {"hash": h, "size": len(data)}
        blobs[h] = (path, data)
    sess = call("POST", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/assets-upload-session", {"manifest": manifest})["result"]
    jwt = sess["jwt"]
    buckets = sess.get("buckets") or []
    print(f"assets: {len(manifest)} files, {sum(len(b) for b in buckets)} to upload")
    for bucket in buckets:
        parts = []
        for h in bucket:
            path, data = blobs[h]
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            parts.append((h, h, ctype, base64.b64encode(data)))
        raw, ctype = multipart(parts)
        res = call("POST", f"/accounts/{ACCOUNT}/workers/assets/upload?base64=true", raw=raw, ctype=ctype, auth=jwt)
        if res.get("result", {}).get("jwt"):
            jwt = res["result"]["jwt"]
    return jwt


def deploy(db, salt, admin, assets_jwt):
    with open(os.path.join(WEB, "_headers")) as f:
        headers = f.read()
    meta = {
        "main_module": "worker.js",
        "compatibility_date": "2026-09-01",
        "bindings": [
            {"type": "d1", "name": "DB", "id": db},
            {"type": "secret_text", "name": "SALT", "text": salt},
            {"type": "secret_text", "name": "ADMIN", "text": admin},
            {"type": "assets", "name": "ASSETS"},
            {"type": "ratelimit", "name": "JOIN_LIMIT", "namespace_id": "4201", "simple": {"limit": 10, "period": 60}},
        ],
        "assets": {"jwt": assets_jwt, "config": {"html_handling": "auto-trailing-slash", "not_found_handling": "none", "_headers": headers}},
        "observability": {"enabled": False},
    }
    with open(WORKER, "rb") as f:
        code = f.read()
    raw, ctype = multipart([("metadata", None, "application/json", json.dumps(meta)), ("worker.js", "worker.js", "application/javascript+module", code)])
    call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}", raw=raw, ctype=ctype)
    print("deployed worker", SCRIPT)


def preview(on):
    call("POST", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/subdomain", {"enabled": on, "previews_enabled": False})
    sub = call("GET", f"/accounts/{ACCOUNT}/workers/subdomain")["result"]["subdomain"]
    print(("preview on: " if on else "preview off: ") + f"https://{SCRIPT}.{sub}.workers.dev")


def domains():
    zone = call("GET", f"/zones?name={ZONE}")["result"][0]
    print("zone", ZONE, zone["status"])
    if zone["status"] != "active":
        raise SystemExit("zone not active yet; nameservers still propagating")
    for host in HOSTS:
        call("PUT", f"/accounts/{ACCOUNT}/workers/domains", {"hostname": host, "service": SCRIPT, "zone_id": zone["id"], "environment": "production"})
        print("bound", host)


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "deploy"
    if step == "build":
        print(len(build()), "files in", DIST)
    elif step == "deploy":
        files = build()
        db = database()
        salt, admin = secret_values()
        deploy(db, salt, admin, upload_assets(files))
    elif step == "preview-on":
        preview(True)
    elif step == "preview-off":
        preview(False)
    elif step == "domains":
        domains()
    else:
        raise SystemExit("usage: deploy_site.py [build|deploy|preview-on|preview-off|domains]")
