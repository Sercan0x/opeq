import json
import os
import sys

from deploy_site import ACCOUNT, ZONE, call, multipart

ROOT = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(ROOT, "rpc", "worker.js")
UPSTREAM_FILE = os.path.expanduser("~/.opeq-rpc")
EVM_FILE = os.path.expanduser("~/.opeq-evm-rpc")
SCRIPT = "opeq-rpc"
HOST = "rpc.opeq.io"


def upstream():
    if not os.path.exists(UPSTREAM_FILE):
        return None
    if os.stat(UPSTREAM_FILE).st_mode & 0o077:
        raise SystemExit(f"{UPSTREAM_FILE} must be readable only by you: chmod 600 {UPSTREAM_FILE}")
    urls = [line.strip() for line in open(UPSTREAM_FILE) if line.strip().startswith("https://")]
    if not urls:
        raise SystemExit(f"{UPSTREAM_FILE} has no https:// line")
    return ",".join(urls)


def evm_upstream():
    if not os.path.exists(EVM_FILE):
        return None
    if os.stat(EVM_FILE).st_mode & 0o077:
        raise SystemExit(f"{EVM_FILE} must be readable only by you: chmod 600 {EVM_FILE}")
    out = {}
    for line in open(EVM_FILE):
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].startswith("https://"):
            out.setdefault(parts[0], []).append(parts[1])
    return json.dumps(out) if out else None


def deploy():
    bindings = [
        {"type": "ratelimit", "name": "LIMIT", "namespace_id": "4101", "simple": {"limit": 300, "period": 60}},
        {"type": "ratelimit", "name": "SEND_LIMIT", "namespace_id": "4102", "simple": {"limit": 30, "period": 60}},
    ]
    bindings.append({"type": "ratelimit", "name": "GLOBAL", "namespace_id": "4103", "simple": {"limit": 6000, "period": 60}})
    up = upstream()
    if up:
        bindings.append({"type": "secret_text", "name": "UPSTREAM", "text": up})
    elif "--public" not in sys.argv:
        raise SystemExit(f"{UPSTREAM_FILE} is missing; deploying now would drop the private upstream. Pass --public only if that is what you want")
    evm = evm_upstream()
    if evm:
        bindings.append({"type": "secret_text", "name": "EVM_UPSTREAM", "text": evm})
    meta = {"main_module": "worker.js", "compatibility_date": "2026-09-01", "bindings": bindings, "observability": {"enabled": False}}
    with open(WORKER, "rb") as f:
        code = f.read()
    raw, ctype = multipart([("metadata", None, "application/json", json.dumps(meta)), ("worker.js", "worker.js", "application/javascript+module", code)])
    call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}", raw=raw, ctype=ctype)
    print("deployed worker", SCRIPT, "upstream:", f"{len(up.split(','))} private endpoint(s)" if up else "public mainnet RPC (no ~/.opeq-rpc yet)")
    print("evm upstream:", f"private endpoints for chains {sorted(json.loads(evm))}" if evm else "public RPCs (no ~/.opeq-evm-rpc)")


def domain():
    zone = call("GET", f"/zones?name={ZONE}")["result"][0]
    call("PUT", f"/accounts/{ACCOUNT}/workers/domains", {"hostname": HOST, "service": SCRIPT, "zone_id": zone["id"], "environment": "production"})
    print("bound", HOST)


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "deploy"
    if step == "deploy":
        deploy()
    elif step == "domain":
        domain()
    else:
        raise SystemExit("usage: deploy_rpc.py [deploy|domain]")
