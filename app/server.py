#!/usr/bin/env python3
"""Snowglobe backend: static files + a tiny JSON/upload API. Standard library only.

Configuration (environment variables):
  PORT             listen port (default 8000)
  HOST             bind address (default 0.0.0.0)
  DATA_DIR         where photos and settings are stored (default ./data)
  MAX_UPLOAD_MB    max accepted photo size in MB (default 5)
  BASE_PATH        URL prefix when served behind a reverse proxy, e.g. /snow (default "")
  RATE_LIMIT       max uploads per IP per RATE_WINDOW seconds (default 10)
  RATE_WINDOW      rate limit window in seconds (default 60)
  MAX_GLOBES       max number of stored globes (default 10000)
  TRUST_PROXY      set to 1 to use the first X-Forwarded-For entry as client IP
                   (only enable behind a proxy you control)
  DEFAULT_LANG     default UI language code (default el)
"""
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
BASE_RE = re.compile(r"^(/[A-Za-z0-9._~-]+)*$")
LANG_RE = re.compile(r"^[a-z]{2,3}$")

SHAPES = ("plaque", "sphere")
BASES = ("wood", "gold", "ice")
DEFAULT_CONFIG = {
    "shape": "plaque",
    "base": "wood",
    "snow": {"amount": 800, "size": 1.0, "color": "#ffffff"},
}
TEMPLATED = {"index.html", "manifest.webmanifest", "sw.js"}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; "
        "script-src 'self'; connect-src 'self'; worker-src 'self'; "
        "manifest-src 'self'; object-src 'none'; base-uri 'self'; "
        "form-action 'self'; frame-ancestors 'none'"
    ),
}


class ConfigError(ValueError):
    pass


def sniff_image(data):
    """Return (mime, ext) from magic bytes, or None."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png", "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


def validate_config(raw):
    """Whitelist-validate user settings; returns a clean dict or raises ConfigError."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ConfigError("config must be an object")
    shape = raw.get("shape", DEFAULT_CONFIG["shape"])
    base = raw.get("base", DEFAULT_CONFIG["base"])
    if shape not in SHAPES:
        raise ConfigError("invalid shape")
    if base not in BASES:
        raise ConfigError("invalid base")
    snow = raw.get("snow", {})
    if not isinstance(snow, dict):
        raise ConfigError("invalid snow")
    d = DEFAULT_CONFIG["snow"]
    amount = snow.get("amount", d["amount"])
    size = snow.get("size", d["size"])
    color = snow.get("color", d["color"])
    if isinstance(amount, bool) or not isinstance(amount, int) or not 50 <= amount <= 3000:
        raise ConfigError("invalid snow.amount")
    if isinstance(size, bool) or not isinstance(size, (int, float)) or not 0.3 <= size <= 4:
        raise ConfigError("invalid snow.size")
    if not isinstance(color, str) or not COLOR_RE.match(color):
        raise ConfigError("invalid snow.color")
    return {
        "shape": shape,
        "base": base,
        "snow": {"amount": amount, "size": float(size), "color": color.lower()},
    }


class RateLimiter:
    """Simple in-memory sliding-window limiter, keyed by client IP."""

    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self.hits = {}
        self.lock = threading.Lock()

    def allow(self, key, now=None):
        now = time.monotonic() if now is None else now
        with self.lock:
            q = self.hits.setdefault(key, deque())
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            if len(self.hits) > 10000:  # opportunistic cleanup
                for k in [k for k, v in self.hits.items() if not v or now - v[-1] > self.window]:
                    del self.hits[k]
            return True


class Store:
    def __init__(self, data_dir, max_globes):
        self.dir = Path(data_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.max_globes = max_globes
        self.lock = threading.Lock()

    def _count(self):
        return sum(1 for _ in self.dir.glob("*.json"))

    def create(self, photo, mime, ext, config):
        with self.lock:
            if self._count() >= self.max_globes:
                return None
            gid = secrets.token_urlsafe(12)
            meta = {"id": gid, "mime": mime, "photo": gid + "." + ext,
                    "created": int(time.time()), "config": config}
            self._write(self.dir / (gid + "." + ext), photo)
            self._write(self.dir / (gid + ".json"), json.dumps(meta).encode())
            return gid

    @staticmethod
    def _write(path, data):
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, path)

    def meta(self, gid):
        if not ID_RE.match(gid):
            return None
        try:
            return json.loads((self.dir / (gid + ".json")).read_text())
        except (OSError, ValueError):
            return None

    def photo(self, gid):
        meta = self.meta(gid)
        if not meta:
            return None
        try:
            return meta["mime"], (self.dir / Path(meta["photo"]).name).read_bytes()
        except (OSError, KeyError):
            return None


class Handler(BaseHTTPRequestHandler):
    server_version = "snowglobe"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # --- helpers -----------------------------------------------------------
    def client_ip(self):
        if self.server.trust_proxy:
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[0].strip()
        return self.client_address[0]

    def send_bytes(self, status, body, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, obj, extra=None):
        h = {"Cache-Control": "no-store"}
        h.update(extra or {})
        self.send_bytes(status, json.dumps(obj).encode(), "application/json", h)

    def error(self, status, msg):
        self.send_json(status, {"error": msg}, {"Connection": "close"} if status in (413, 429) else None)
        if status in (413, 429):
            self.close_connection = True

    def route_path(self):
        """Request path with BASE_PATH stripped, or None if outside it."""
        path = urlsplit(self.path).path
        base = self.server.base_path
        if base:
            if path == base:
                return "/"
            if not path.startswith(base + "/"):
                return None
            path = path[len(base):]
        return path

    # --- GET ---------------------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.route_path()
        if path is None:
            return self.error(404, "not found")
        if path == "/":
            return self.serve_template("index.html", "")
        if path == "/sw.js":
            return self.serve_template("sw.js", "", {"Service-Worker-Allowed": self.server.base_path + "/"})
        m = re.match(r"^/g/([^/]+)$", path)
        if m:
            gid = m.group(1)
            if not ID_RE.match(gid) or not self.server.store.meta(gid):
                return self.error(404, "not found")
            return self.serve_template("index.html", gid)
        m = re.match(r"^/api/globes/([^/]+)(/photo)?$", path)
        if m:
            gid, photo = m.group(1), m.group(2)
            if photo:
                res = self.server.store.photo(gid)
                if not res:
                    return self.error(404, "not found")
                return self.send_bytes(200, res[1], res[0], {
                    "Cache-Control": "public, max-age=31536000, immutable",
                    "Content-Security-Policy": "default-src 'none'",
                })
            meta = self.server.store.meta(gid)
            if not meta:
                return self.error(404, "not found")
            return self.send_json(200, {"id": meta["id"], "config": meta["config"]})
        if path == "/manifest.webmanifest":
            return self.serve_template("manifest.webmanifest", "")
        if path.startswith("/static/"):
            return self.serve_static(path[len("/static/"):])
        return self.error(404, "not found")

    def serve_static(self, rel):
        rel = unquote(rel)
        if "\x00" in rel or "\\" in rel:
            return self.error(404, "not found")
        target = (STATIC_DIR / rel).resolve()
        try:
            target.relative_to(STATIC_DIR)
        except ValueError:
            return self.error(404, "not found")
        if not target.is_file():
            return self.error(404, "not found")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs"):
            ctype = "text/javascript"
        self.send_bytes(200, target.read_bytes(), ctype, {"Cache-Control": "no-cache"})

    def serve_template(self, name, view_id, extra=None):
        text = (STATIC_DIR / name).read_text(encoding="utf-8")
        text = (text.replace("%BASE%", self.server.base_path)
                    .replace("%VIEW%", view_id)
                    .replace("%LANG%", self.server.default_lang))
        ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript",
                 "webmanifest": "application/manifest+json"}[name.rsplit(".", 1)[1]]
        h = {"Cache-Control": "no-cache"}
        h.update(extra or {})
        self.send_bytes(200, text.encode("utf-8"), ctype, h)

    # --- POST --------------------------------------------------------------
    def do_POST(self):
        path = self.route_path()
        if path != "/api/globes":
            return self.error(404, "not found")
        if not self.server.limiter.allow(self.client_ip()):
            return self.error(429, "too many uploads, try later")
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype not in ("image/jpeg", "image/png", "image/webp"):
            return self.error(415, "only jpeg, png and webp are accepted")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.error(411, "Content-Length required")
        if length <= 0:
            return self.error(400, "empty body")
        if length > self.server.max_upload:
            return self.error(413, "file too large")
        qs = parse_qs(urlsplit(self.path).query)
        raw_cfg = (qs.get("config") or [None])[0]
        try:
            if raw_cfg is not None and len(raw_cfg) > 2048:
                raise ConfigError("config too long")
            config = validate_config(json.loads(raw_cfg) if raw_cfg else None)
        except (ValueError, RecursionError):
            return self.error(400, "invalid config")
        body = self.rfile.read(length)
        if len(body) != length:
            return self.error(400, "truncated body")
        sniffed = sniff_image(body)
        if not sniffed or sniffed[0] != ctype:
            return self.error(415, "file content does not match an allowed image type")
        gid = self.server.store.create(body, sniffed[0], sniffed[1], config)
        if gid is None:
            return self.error(507, "storage limit reached")
        self.send_json(201, {"id": gid, "url": self.server.base_path + "/g/" + gid})

    def log_message(self, fmt, *args):
        if not self.server.quiet:
            sys.stderr.write("%s - %s\n" % (self.client_ip(), fmt % args))


def make_server(host="0.0.0.0", port=8000, data_dir="./data", max_upload_mb=5.0,
                base_path="", rate_limit=10, rate_window=60, max_globes=10000,
                trust_proxy=False, default_lang="el", quiet=False):
    base_path = base_path.rstrip("/")
    if not BASE_RE.match(base_path):
        raise SystemExit("BASE_PATH must look like /prefix (letters, digits, . _ ~ -)")
    if not LANG_RE.match(default_lang):
        raise SystemExit("DEFAULT_LANG must be a 2-3 letter code")
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    srv.store = Store(data_dir, max_globes)
    srv.max_upload = int(max_upload_mb * 1024 * 1024)
    srv.base_path = base_path
    srv.limiter = RateLimiter(rate_limit, rate_window)
    srv.trust_proxy = trust_proxy
    srv.default_lang = default_lang
    srv.quiet = quiet
    return srv


def main():
    env = os.environ.get
    srv = make_server(
        host=env("HOST", "0.0.0.0"),
        port=int(env("PORT", "8000")),
        data_dir=env("DATA_DIR", "./data"),
        max_upload_mb=float(env("MAX_UPLOAD_MB", "5")),
        base_path=env("BASE_PATH", ""),
        rate_limit=int(env("RATE_LIMIT", "10")),
        rate_window=int(env("RATE_WINDOW", "60")),
        max_globes=int(env("MAX_GLOBES", "10000")),
        trust_proxy=env("TRUST_PROXY", "") == "1",
        default_lang=env("DEFAULT_LANG", "el"),
    )
    print("snowglobe listening on port %d" % srv.server_address[1], flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
