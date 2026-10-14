import hmac
import http.server
import json
import os
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "waitlist"))
from store import Fail, Waitlist

WAITLIST = Waitlist(os.path.join(ROOT, "waitlist", "dev.db"), os.environ.get("WAITLIST_SALT") or secrets.token_hex(16))
ADMIN = os.environ.get("WAITLIST_ADMIN", "")


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def reply(self, status, data):
        raw = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/waitlist/export":
            got = self.headers.get("Authorization", "")
            if not ADMIN or not hmac.compare_digest(got, f"Bearer {ADMIN}"):
                return self.reply(401, {"error": "unauthorized"})
            return self.reply(200, WAITLIST.export())
        if self.path.startswith("/api/"):
            return self.reply(404, {"error": "not found"})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/waitlist/join":
            return self.reply(404, {"error": "not found"})
        origin = self.headers.get("Origin")
        if origin and origin.split("://", 1)[-1] != self.headers.get("Host"):
            return self.reply(403, {"error": "Requests from other sites are not allowed."})
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.reply(400, {"error": "Bad request."})
        if size < 0 or size > 2048:
            return self.reply(413, {"error": "Request too large."})
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self.reply(400, {"error": "Bad request."})
        try:
            out = WAITLIST.join(body, self.client_address[0])
        except Fail as e:
            return self.reply(e.status, {"error": e.message, "step": e.step})
        return self.reply(200, out)


os.chdir(os.path.join(HERE, ".."))
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1]) if len(sys.argv) > 1 else 8790), NoCache).serve_forever()
