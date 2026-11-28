import hashlib
import json
import re
import struct
import unittest
import zlib
from pathlib import Path

import test_server

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "app" / "static"
MP = STATIC / "vendor" / "mediapipe"

PINNED = {
    "vision_bundle.mjs": "fb0c02c296f44ce0cc324ba16bd646d8773eb4a7847db4019cc4d0430db7a9b5",
    "wasm/vision_wasm_internal.js": "2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309",
    "wasm/vision_wasm_internal.wasm": "225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf",
    "selfie_multiclass_256x256.tflite": "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0",
}
MODEL_SIZE = 16371837
CUT = {"shape": "cutout", "base": "wood", "snow": {"amount": 800, "size": 1, "color": "#ffffff"}}


def png(color_type, extra=b""):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, color_type, 0, 0, 0)
    idat = zlib.compress(b"\x00" + b"\x80" * bpp)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + extra + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def trns():
    data = b"\x00\x00\x00\x00\x00\x00"
    return struct.pack(">I", len(data)) + b"tRNS" + data + struct.pack(">I", zlib.crc32(b"tRNS" + data))


def riff(*chunks):
    body = b"WEBP"
    for kind, data in chunks:
        body += kind + struct.pack("<I", len(data)) + data + (b"\x00" if len(data) & 1 else b"")
    return b"RIFF" + struct.pack("<I", len(body)) + body


def webp_vp8x(alpha, with_alph=True):
    flags = 0x10 if alpha else 0
    vp8x = bytes([flags]) + b"\x00\x00\x00" + b"\x00\x00\x00" + b"\x00\x00\x00"
    chunks = [(b"VP8X", vp8x)]
    if alpha and with_alph:
        chunks.append((b"ALPH", b"\x00\x00"))
    chunks.append((b"VP8 ", b"\x00" * 10))
    return riff(*chunks)


def webp_vp8l(alpha):
    bits = (1 << 28) if alpha else 0
    return riff((b"VP8L", b"\x2f" + struct.pack("<I", bits) + b"\x00" * 4))


WEBP_LOSSY = riff((b"VP8 ", b"\x00" * 10))
JPG = test_server.JPG


class TestCutoutUpload(test_server.Base):
    def test_accepts_png_with_alpha(self):
        for name, data in (("rgba", png(6)), ("grey+alpha", png(4)), ("rgb+tRNS", png(2, trns()))):
            r, body = self.upload(data, "image/png", CUT)
            self.assertEqual(r.status, 201, name)
            gid = json.loads(body)["id"]
            cfg = json.loads(self.req("GET", "/api/globes/" + gid)[1])["config"]
            self.assertEqual(cfg["shape"], "cutout")
            r, got = self.req("GET", "/api/globes/%s/photo" % gid)
            self.assertEqual((got, r.getheader("Content-Type")), (data, "image/png"))

    def test_accepts_webp_with_alpha(self):
        for name, data in (("vp8x+alph", webp_vp8x(True)), ("vp8l", webp_vp8l(True))):
            r, _ = self.upload(data, "image/webp", CUT)
            self.assertEqual(r.status, 201, name)

    def test_rejects_cutout_without_alpha(self):
        cases = (
            ("png rgb", png(2), "image/png"),
            ("png grey", png(0), "image/png"),
            ("png palette", png(3), "image/png"),
            ("jpeg", JPG, "image/jpeg"),
            ("webp lossy", WEBP_LOSSY, "image/webp"),
            ("webp vp8x no alpha", webp_vp8x(False), "image/webp"),
            ("webp vp8l no alpha", webp_vp8l(False), "image/webp"),
            ("png stub", test_server.PNG, "image/png"),
            ("webp stub", test_server.WEBP, "image/webp"),
        )
        for name, data, ctype in cases:
            r, _ = self.upload(data, ctype, CUT)
            self.assertEqual(r.status, 415, name)
        self.assertEqual(self.srv.store._count(), 0)

    def test_truncated_headers_are_rejected_not_crashing(self):
        for data, ctype in ((png(6)[:20], "image/png"), (webp_vp8x(True)[:14], "image/webp"),
                            (b"RIFF\x00\x00\x00\x00WEBPVP8L\xff\xff\xff\xff", "image/webp")):
            self.assertEqual(self.upload(data, ctype, CUT)[0].status, 415)

    def test_other_shapes_unaffected(self):
        for shape in ("plaque", "sphere"):
            cfg = dict(CUT, shape=shape)
            for data, ctype in ((png(2), "image/png"), (JPG, "image/jpeg"), (png(6), "image/png")):
                self.assertEqual(self.upload(data, ctype, cfg)[0].status, 201, shape)

    def test_old_settings_still_load(self):
        old = {"shape": "sphere", "base": "ice", "snow": {"amount": 300, "size": 1.5, "color": "#a0b0c0"}}
        gid = json.loads(self.upload(JPG, "image/jpeg", old)[1])["id"]
        got = json.loads(self.req("GET", "/api/globes/" + gid)[1])["config"]
        self.assertEqual(got, old | {"snow": {"amount": 300, "size": 1.5, "color": "#a0b0c0"}})
        self.assertEqual(test_server.server.validate_config(None)["shape"], "plaque")
        self.assertEqual(test_server.server.validate_config({"shape": "plaque"})["shape"], "plaque")
        with self.assertRaises(test_server.server.ConfigError):
            test_server.server.validate_config({"shape": "cube"})


class TestVendorServing(test_server.Base):
    def test_mime_types(self):
        r, _ = self.req("HEAD", "/static/vendor/mediapipe/wasm/vision_wasm_internal.wasm")
        self.assertEqual(r.getheader("Content-Type"), "application/wasm")
        r, _ = self.req("HEAD", "/static/vendor/mediapipe/selfie_multiclass_256x256.tflite")
        self.assertEqual(r.getheader("Content-Type"), "application/octet-stream")
        r, _ = self.req("HEAD", "/static/vendor/mediapipe/vision_bundle.mjs")
        self.assertEqual(r.getheader("Content-Type"), "text/javascript")

    def test_immutable_only_for_mediapipe(self):
        for p in ("vendor/mediapipe/vision_bundle.mjs", "vendor/mediapipe/wasm/vision_wasm_internal.js",
                  "vendor/mediapipe/wasm/vision_wasm_internal.wasm", "vendor/mediapipe/LICENSE"):
            r, _ = self.req("HEAD", "/static/" + p)
            self.assertEqual(r.getheader("Cache-Control"), "public, max-age=31536000, immutable", p)
        for p in ("app.js", "segment.js", "vendor/three.module.min.js", "vendor/RoomEnvironment.js", "style.css"):
            r, _ = self.req("HEAD", "/static/" + p)
            self.assertEqual(r.getheader("Cache-Control"), "no-cache", p)

    def test_content_length_and_no_etag(self):
        for p in ("vendor/mediapipe/selfie_multiclass_256x256.tflite", "vendor/mediapipe/wasm/vision_wasm_internal.wasm",
                  "app.js"):
            r, data = self.req("GET", "/static/" + p)
            self.assertEqual(r.status, 200)
            self.assertEqual(int(r.getheader("Content-Length")), len(data), p)
            self.assertEqual(len(data), (STATIC / p).stat().st_size, p)
            self.assertIsNone(r.getheader("ETag"), p)
            self.assertIsNone(r.getheader("Last-Modified"), p)
            self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        r, _ = self.req("GET", "/static/app.js")
        self.assertEqual(r.status, 200)

    def test_conditional_request_gets_full_body(self):
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", "/static/vendor/mediapipe/vision_bundle.mjs",
                  headers={"If-None-Match": '"x"', "If-Modified-Since": "Mon, 01 Jan 2035 00:00:00 GMT"})
        r = c.getresponse()
        self.assertEqual(r.status, 200)
        r.read()
        c.close()

    def test_streamed_body_matches_pinned_hash(self):
        r, data = self.req("GET", "/static/vendor/mediapipe/selfie_multiclass_256x256.tflite")
        self.assertEqual(len(data), MODEL_SIZE)
        self.assertEqual(hashlib.sha256(data).hexdigest(), PINNED["selfie_multiclass_256x256.tflite"])

    def test_csp(self):
        r, _ = self.req("GET", "/")
        csp = r.getheader("Content-Security-Policy")
        directives = {d.split()[0]: d.split()[1:] for d in csp.split(";") if d.strip()}
        script = directives["script-src"]
        self.assertEqual(script, ["'self'", "'wasm-unsafe-eval'"])
        for bad in ("'unsafe-eval'", "'unsafe-inline'", "blob:", "data:", "*"):
            self.assertNotIn(bad, script)
        self.assertNotIn("'unsafe-eval'", csp)
        self.assertNotIn("'unsafe-inline'", csp)
        self.assertEqual(directives["connect-src"], ["'self'"])  # also keeps the vendored runtime's telemetry URL inert
        self.assertEqual(directives["worker-src"], ["'self'"])
        self.assertNotIn("blob:", directives["default-src"])
        # the static files carry the same policy
        r, _ = self.req("HEAD", "/static/vendor/mediapipe/vision_bundle.mjs")
        self.assertIn("'wasm-unsafe-eval'", r.getheader("Content-Security-Policy"))


class TestVendoredFiles(unittest.TestCase):
    def test_sha256_of_vendored_files(self):
        for rel, want in PINNED.items():
            self.assertEqual(hashlib.sha256((MP / rel).read_bytes()).hexdigest(), want, rel)
        self.assertEqual((MP / "selfie_multiclass_256x256.tflite").stat().st_size, MODEL_SIZE)

    def test_only_the_needed_files_are_vendored(self):
        files = {p.relative_to(MP).as_posix() for p in MP.rglob("*") if p.is_file()}
        self.assertEqual(files, set(PINNED) | {"LICENSE", "MODEL_CARD.md"})
        self.assertIn("Apache License", (MP / "LICENSE").read_text())
        self.assertIn("Version 2.0", (MP / "LICENSE").read_text())
        card = (MP / "MODEL_CARD.md").read_text()
        self.assertIn("Model card", card)
        self.assertIn(PINNED["selfie_multiclass_256x256.tflite"], card)

    def test_vendor_script_pins_match(self):
        script = (ROOT / "scripts" / "vendor_mediapipe.py").read_text()
        for rel, want in PINNED.items():
            self.assertIn(want, script, rel)
        self.assertIn("sha512-sxJyfhbN+EamexhaaCmUlw7v8vWWMum7VDsORe6d4c8Dk/xlI4qiIgoSw9cE9hpvYhVRRVLIA8y605FbqWkNeQ==", script)
        self.assertIn("tasks-vision-1.2.3.tgz", script)
        self.assertNotIn("vision_wasm_module_internal", script)
        self.assertTrue((ROOT / "scripts" / "vendor-mediapipe.sh").is_file())

    def test_no_loading_urls_in_vendored_js(self):
        load_call = re.compile(r"""(?:\bfetch|\bimport|importScripts|\bopen|new\s+URL)\s*\(\s*[`"']https?:""")
        load_attr = re.compile(r"""\b(?:src|href)\s*=\s*[`"']https?:""")
        hosts = re.compile(r"cdn\.jsdelivr\.net|storage\.googleapis\.com")
        for rel in ("vision_bundle.mjs", "wasm/vision_wasm_internal.js"):
            txt = (MP / rel).read_text(encoding="utf-8")
            self.assertIsNone(load_call.search(txt), rel)
            self.assertIsNone(load_attr.search(txt), rel)
            self.assertIsNone(hosts.search(txt), rel)

    def test_no_eval_or_workers_in_vendored_js(self):
        for rel in ("vision_bundle.mjs", "wasm/vision_wasm_internal.js"):
            txt = (MP / rel).read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"\beval\s*\(", txt), rel)
            self.assertIsNone(re.search(r"new\s+Function\b", txt), rel)
            self.assertIsNone(re.search(r"new\s+(?:Shared)?Worker\b", txt), rel)
            self.assertNotIn("blob:", txt, rel)
        # the only Function( occurrences are helper names (destructorFunction, createNamedFunction,
        # runEmAsmFunction), never the Function constructor
        wasm_js = (MP / "wasm/vision_wasm_internal.js").read_text(encoding="utf-8")
        self.assertNotRegex(wasm_js, r"(?<![\w.])Function\(")
        # the dynamic loaders are only reached from a worker; on the main thread a <script src> is used
        bundle = (MP / "vision_bundle.mjs").read_text(encoding="utf-8")
        self.assertIn('"function"!=typeof importScripts', bundle)
        self.assertIn("createElement(\"script\")", bundle)


class TestClientWiring(unittest.TestCase):
    def read(self, name):
        return (STATIC / name).read_text(encoding="utf-8")

    def test_segment_is_lazy_main_thread_and_local(self):
        seg = self.read("segment.js")
        self.assertIn("import(`${root}/vision_bundle.mjs`)", seg)
        self.assertNotRegex(seg, r"^import .*mediapipe", re.M)
        self.assertNotIn("Worker", seg)
        self.assertNotRegex(seg, r"https?://")
        self.assertIn("forVisionTasks(`${root}/wasm`)", seg)
        for const in ("MIN_COVERAGE = 0.03", "MAX_OUT = 1024", "PERSON_CLASSES = [1, 2, 3, 4, 5]"):
            self.assertIn(const, seg)
        app = self.read("app.js")
        self.assertNotIn("mediapipe", app)
        self.assertNotIn("vision_bundle", app)

    def test_service_worker_does_not_precache_mediapipe(self):
        sw = self.read("sw.js")
        shell = sw[sw.index("const SHELL"):sw.index(".map(")]
        self.assertNotIn("mediapipe", shell)
        self.assertIn("/static/segment.js", shell)
        self.assertIn('"snowglobe-v4"', sw)
        self.assertNotIn("snowglobe-v3", sw)

    def test_cutout_shape_and_messages(self):
        html, i18n, g = self.read("index.html"), self.read("i18n.js"), self.read("globe.js")
        self.assertRegex(html, r'<option value="cutout" data-i18n="shapeCutout"')
        for text in ('shapeCutout: "Φιγούρες"', 'shapeCutout: "Figures"', 'noPeople: "Δεν βρέθηκαν άτομα"', "segmenting:"):
            self.assertIn(text, i18n)
        for frag in ('"cutout"', "alphaTest: 0.5", "CUT_H = 0.55 * 2 * R", "CUT_SINK", "contactShadowGeometry",
                     "THREE.DoubleSide", "CREAM"):
            self.assertIn(frag, g)
        # the old shapes still build exactly as before
        self.assertIn("plaque.add(frame, pic, back)", g)

    def test_upload_sends_cutout_blob_only_for_cutout(self):
        app = self.read("app.js")
        self.assertIn('readConfig().shape === "cutout" && cutBlob', app)
        self.assertIn('"image/webp"', app)


if __name__ == "__main__":
    unittest.main()
