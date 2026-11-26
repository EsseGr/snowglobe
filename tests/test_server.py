import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "app"))
import server  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 64


class Base(unittest.TestCase):
    opts = {}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.srv = server.make_server(host="127.0.0.1", port=0, data_dir=self.tmp.name,
                                      quiet=True, **self.opts)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def req(self, method, path, body=None, ctype=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": ctype} if ctype else {}
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def upload(self, body=PNG, ctype="image/png", config=None):
        q = "?config=" + quote(json.dumps(config)) if config is not None else ""
        return self.req("POST", "/api/globes" + q, body, ctype)


class TestUpload(Base):
    def test_roundtrip(self):
        cfg = {"shape": "sphere", "base": "gold", "snow": {"amount": 500, "size": 2, "color": "#AABBCC"}}
        r, data = self.upload(JPG, "image/jpeg", cfg)
        self.assertEqual(r.status, 201)
        info = json.loads(data)
        gid = info["id"]
        self.assertEqual(info["url"], "/g/" + gid)
        self.assertGreaterEqual(len(gid), 16)
        r, data = self.req("GET", "/api/globes/" + gid)
        self.assertEqual(r.status, 200)
        got = json.loads(data)["config"]
        self.assertEqual(got["base"], "gold")
        self.assertEqual(got["snow"]["color"], "#aabbcc")
        r, data = self.req("GET", "/api/globes/%s/photo" % gid)
        self.assertEqual((r.status, data, r.getheader("Content-Type")), (200, JPG, "image/jpeg"))
        r, _ = self.req("GET", "/g/" + gid)
        self.assertEqual(r.status, 200)

    def test_ids_random(self):
        ids = {json.loads(self.upload()[1])["id"] for _ in range(5)}
        self.assertEqual(len(ids), 5)

    def test_defaults(self):
        gid = json.loads(self.upload(WEBP, "image/webp")[1])["id"]
        cfg = json.loads(self.req("GET", "/api/globes/" + gid)[1])["config"]
        self.assertEqual(cfg, server.DEFAULT_CONFIG)

    def test_bad_type(self):
        self.assertEqual(self.upload(b"GIF89a....", "image/gif")[0].status, 415)
        self.assertEqual(self.upload(b"<script>", "text/html")[0].status, 415)

    def test_content_mismatch(self):
        self.assertEqual(self.upload(b"not an image at all", "image/png")[0].status, 415)
        self.assertEqual(self.upload(PNG, "image/jpeg")[0].status, 415)

    def test_bad_config(self):
        for cfg in ({"base": "../x"}, {"shape": "cube"}, {"snow": {"amount": 10**9}},
                    {"snow": {"color": "red"}}, {"snow": {"size": True}}, [1]):
            self.assertEqual(self.upload(config=cfg)[0].status, 400, cfg)
        r, _ = self.req("POST", "/api/globes?config=%7Bnotjson", PNG, "image/png")
        self.assertEqual(r.status, 400)

    def test_no_content_length(self):
        r, _ = self.req("POST", "/api/globes", None, "image/png")
        self.assertIn(r.status, (400, 411))


class TestLimits(Base):
    opts = {"max_upload_mb": 0.001}

    def test_too_large(self):
        self.assertEqual(self.upload(PNG + b"\x00" * 2000)[0].status, 413)
        self.assertEqual(self.upload()[0].status, 201)


class TestRate(Base):
    opts = {"rate_limit": 2}

    def test_rate_limit(self):
        self.assertEqual(self.upload()[0].status, 201)
        self.assertEqual(self.upload()[0].status, 201)
        self.assertEqual(self.upload()[0].status, 429)

    def test_limiter_window(self):
        rl = server.RateLimiter(1, 10)
        self.assertTrue(rl.allow("a", now=0))
        self.assertFalse(rl.allow("a", now=5))
        self.assertTrue(rl.allow("b", now=5))
        self.assertTrue(rl.allow("a", now=11))


class TestStorageCap(Base):
    opts = {"max_globes": 1}

    def test_cap(self):
        self.assertEqual(self.upload()[0].status, 201)
        self.assertEqual(self.upload()[0].status, 507)


class TestSafety(Base):
    def test_traversal(self):
        for p in ("/static/../server.py", "/static/%2e%2e/server.py", "/static/..%2fserver.py",
                  "/static/%2e%2e%2f%2e%2e%2ftests/test_server.py", "/static/..%5cserver.py",
                  "/static//etc/passwd", "/static/%00", "/api/globes/..%2f..%2fetc%2fpasswd",
                  "/api/globes/../../etc/passwd", "/g/..%2fx", "/api/globes/%2e%2e/photo"):
            r, data = self.req("GET", p)
            self.assertIn(r.status, (400, 404), p)
            self.assertNotIn(b"make_server", data, p)

    def test_unknown_id(self):
        self.assertEqual(self.req("GET", "/g/" + "A" * 16)[0].status, 404)
        self.assertEqual(self.req("GET", "/api/globes/" + "A" * 16 + "/photo")[0].status, 404)

    def test_headers(self):
        r, _ = self.req("GET", "/")
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn("default-src 'self'", r.getheader("Content-Security-Policy"))
        self.assertEqual(r.getheader("X-Frame-Options"), "DENY")
        self.assertNotIn("Python", r.getheader("Server", ""))

    def test_post_wrong_path(self):
        self.assertEqual(self.req("POST", "/static/app.js", b"x", "image/png")[0].status, 404)

    def test_templates_substituted(self):
        for p in ("/", "/manifest.webmanifest", "/sw.js"):
            r, data = self.req("GET", p)
            self.assertEqual(r.status, 200, p)
            self.assertNotIn(b"%BASE%", data)
            self.assertNotIn(b"%VIEW%", data)


class TestBasePath(Base):
    opts = {"base_path": "/snow/"}

    def test_base(self):
        self.assertEqual(self.req("GET", "/snow/")[0].status, 200)
        self.assertEqual(self.req("GET", "/snow")[0].status, 200)
        self.assertEqual(self.req("GET", "/")[0].status, 404)
        r, data = self.req("POST", "/snow/api/globes", PNG, "image/png")
        self.assertEqual(r.status, 201)
        self.assertTrue(json.loads(data)["url"].startswith("/snow/g/"))
        r, data = self.req("GET", "/snow/")
        self.assertIn(b'content="/snow"', data)

    def test_invalid_base(self):
        with self.assertRaises(SystemExit):
            server.make_server(port=0, data_dir=self.tmp.name, base_path='/a"><x')


class TestSniff(unittest.TestCase):
    def test_sniff(self):
        self.assertEqual(server.sniff_image(PNG)[1], "png")
        self.assertEqual(server.sniff_image(WEBP)[1], "webp")
        self.assertIsNone(server.sniff_image(b"RIFF....WAVE"))


if __name__ == "__main__":
    unittest.main()
