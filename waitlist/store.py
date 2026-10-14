import hashlib
import re
import sqlite3
import threading
import time

FOLLOW = "opeqio"
EMAIL = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$")
HANDLE = re.compile(r"^@?([A-Za-z0-9_]{1,15})$")
POST = re.compile(r"^https?://(?:www\.|mobile\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})/status/(\d{5,25})(?:[/?#].*)?$")
JOINS_PER_HOUR = 20

SCHEMA = """
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  x_handle TEXT NOT NULL,
  post_url TEXT NOT NULL UNIQUE,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_ip ON waitlist (ip_hash, created_at);
"""


class Fail(Exception):
    def __init__(self, status, message, step):
        super().__init__(message)
        self.status = status
        self.message = message
        self.step = step


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def ip_key(ip):
    ip = (ip or "").strip().lower()
    if ":" in ip:
        return ":".join(ip.split(":")[:4]) + "::/64"
    return ip


def check(body):
    m = HANDLE.match(str(body.get("handle", "")).strip())
    if not m:
        raise Fail(400, "Enter your X username, like @satoshi.", "follow")
    handle = m.group(1)
    if handle.lower() == FOLLOW:
        raise Fail(400, "Enter your own X username, not ours.", "follow")
    p = POST.match(str(body.get("url", "")).strip())
    if not p:
        raise Fail(400, "Paste the link to your post. It looks like x.com/you/status/123...", "post")
    author, sid = p.groups()
    if author.lower() != handle.lower():
        raise Fail(400, f"This post is from @{author}, but your username is @{handle}.", "post")
    email = str(body.get("email", "")).strip().lower()
    if len(email) > 254 or not EMAIL.match(email):
        raise Fail(400, "Enter a valid email address.", "email")
    return handle, f"https://x.com/{author.lower()}/status/{sid}", email


class Waitlist:
    def __init__(self, path, salt):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.salt = salt
        self.lock = threading.Lock()

    def join(self, body, ip):
        if body.get("company"):
            raise Fail(400, "Something went wrong. Try again.", "email")
        handle, url, email = check(body)
        ip_hash = sha(self.salt + ip_key(ip))
        now = int(time.time())
        with self.lock:
            recent = self.db.execute("SELECT COUNT(*) FROM waitlist WHERE ip_hash = ? AND created_at > ?", (ip_hash, now - 3600)).fetchone()[0]
            if recent >= JOINS_PER_HOUR:
                raise Fail(429, "Too many sign-ups from this network. Try again in an hour.", "email")
            if self.db.execute("SELECT 1 FROM waitlist WHERE email = ?", (email,)).fetchone():
                raise Fail(409, "This email is already on the list.", "email")
            if self.db.execute("SELECT 1 FROM waitlist WHERE post_url = ?", (url,)).fetchone():
                raise Fail(409, "This post is already used by another sign-up.", "post")
            self.db.execute("INSERT INTO waitlist (email, x_handle, post_url, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)", (email, handle, url, ip_hash, now))
            self.db.commit()
        return {"ok": True}

    def export(self):
        rows = self.db.execute("SELECT id, email, x_handle, post_url, created_at FROM waitlist ORDER BY id").fetchall()
        keys = ["id", "email", "x_handle", "post_url", "created_at"]
        return [dict(zip(keys, r)) for r in rows]
