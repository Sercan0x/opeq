import json
import os
import sys

from deploy_site import call, multipart, ACCOUNT, ZONE

ROOT = os.path.dirname(os.path.abspath(__file__))
DOKO = os.path.join(ROOT, "doko")
LIB = os.path.join(ROOT, "web", "lib")
SCRIPT = "opeq-doko"
DATABASE = "opeq-doko"
HOST = "doko.opeq.io"
MODULES = ["bot.js", "indicators.js", "market.js", "market_bybit.js", "market_hl.js", "optimize.js", "dokoexplain.js"]
VARS = {
    "BASE": f"https://{HOST}",
    "SITE_PAGE": "https://opeq.io/doko",
    "SITE_ORIGINS": "https://opeq.io,https://www.opeq.io",
}


def database():
    found = [d for d in call("GET", f"/accounts/{ACCOUNT}/d1/database?name={DATABASE}")["result"] if d["name"] == DATABASE]
    if found:
        db = found[0]["uuid"]
    else:
        db = call("POST", f"/accounts/{ACCOUNT}/d1/database", {"name": DATABASE})["result"]["uuid"]
        print("created D1", DATABASE)
    with open(os.path.join(DOKO, "schema.sql")) as f:
        for stmt in [s.strip() for s in f.read().split(";") if s.strip()]:
            call("POST", f"/accounts/{ACCOUNT}/d1/database/{db}/query", {"sql": stmt})
    return db


def deploy(db):
    meta = {
        "main_module": "worker.js",
        "compatibility_date": "2026-09-01",
        "bindings": [
            {"type": "d1", "name": "DB", "id": db},
            {"type": "ratelimit", "name": "CONNECT_LIMIT", "namespace_id": "4202", "simple": {"limit": 10, "period": 60}},
            {"type": "ratelimit", "name": "TOOL_LIMIT", "namespace_id": "4203", "simple": {"limit": 60, "period": 60}},
        ] + [{"type": "plain_text", "name": k, "text": v} for k, v in VARS.items()],
        "observability": {"enabled": True},
    }
    parts = [("metadata", None, "application/json", json.dumps(meta))]
    with open(os.path.join(DOKO, "worker.js"), "rb") as f:
        parts.append(("worker.js", "worker.js", "application/javascript+module", f.read()))
    for n in MODULES:
        with open(os.path.join(LIB, n), "rb") as f:
            parts.append((f"lib/{n}", f"lib/{n}", "application/javascript+module", f.read()))
    raw, ctype = multipart(parts)
    call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}", raw=raw, ctype=ctype)
    call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/schedules", [{"cron": "* * * * *"}])
    print("deployed worker", SCRIPT, "with a cron every minute")


def domain():
    zone = call("GET", f"/zones?name={ZONE}")["result"][0]
    call("PUT", f"/accounts/{ACCOUNT}/workers/domains", {"hostname": HOST, "service": SCRIPT, "zone_id": zone["id"], "environment": "production"})
    print("bound", HOST)


def pause():
    call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/schedules", [])
    print("cron removed; agents stop trading until the next deploy")


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "deploy"
    if step == "deploy":
        deploy(database())
    elif step == "domain":
        domain()
    elif step == "pause":
        pause()
    else:
        raise SystemExit("usage: deploy_doko.py [deploy|domain|pause]")
