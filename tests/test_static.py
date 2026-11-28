import re
import unittest
from pathlib import Path

import test_server

STATIC = Path(__file__).resolve().parent.parent / "app" / "static"
TEXT_FILES = [*STATIC.glob("*.js"), STATIC / "vendor" / "RoomEnvironment.js",
              STATIC / "index.html", STATIC / "style.css"]


def read(rel):
    return (STATIC / rel).read_text(encoding="utf-8")


class TestStaticAssets(test_server.Base):
    def test_room_environment_served_as_javascript(self):
        r, data = self.req("GET", "/static/vendor/RoomEnvironment.js")
        self.assertEqual(r.status, 200)
        self.assertIn(r.getheader("Content-Type").split(";")[0], {"text/javascript", "application/javascript"})
        self.assertIn(b"class RoomEnvironment", data)

    def test_relative_imports_resolve_and_are_served(self):
        for f in STATIC.glob("*.js"):
            for spec in re.findall(r"""from\s+["'](\.[^"']+)["']""", f.read_text(encoding="utf-8")):
                target = (f.parent / spec).resolve()
                self.assertTrue(target.is_file(), f"{f.name} imports missing {spec}")
                rel = target.relative_to(STATIC.resolve()).as_posix()
                r, _ = self.req("GET", "/static/" + rel)
                self.assertEqual(r.status, 200, spec)

    def test_base_api_compat(self):
        for base in ("wood", "gold", "ice"):
            r, _ = self.upload(test_server.PNG, "image/png", {"shape": "sphere", "base": base,
                                                              "snow": {"amount": 50, "size": 1, "color": "#ffffff"}})
            self.assertEqual(r.status, 201, base)
        r, _ = self.upload(test_server.PNG, "image/png", {"shape": "sphere", "base": "black",
                                                          "snow": {"amount": 50, "size": 1, "color": "#ffffff"}})
        self.assertEqual(r.status, 400)


class TestStaticSources(unittest.TestCase):
    def test_no_cdn(self):
        files = TEXT_FILES + [STATIC / "sw.js"]
        for f in files:
            txt = f.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"""from\s+["']https?:""", txt), f.name)
            self.assertIsNone(re.search(r"""(src|href)\s*=\s*["']https?:""", txt), f.name)
            for word in ("cdn", "unpkg", "jsdelivr"):
                self.assertNotIn(word, txt.lower(), f"{word} in {f.name}")

    def test_room_environment_imports_local_three(self):
        txt = read("vendor/RoomEnvironment.js")
        self.assertNotRegex(txt, r"from\s+['\"]three['\"]")
        self.assertIn("./three.module.min.js", txt)
        names = re.search(r"import\s*\{([^}]*)\}\s*from", txt).group(1).split(",")
        three = read("vendor/three.module.min.js")
        exported = re.search(r"export\s*\{([^}]*)\}", three[-20000:]).group(1)
        exported_names = {part.split(" as ")[-1].strip() for part in exported.split(",")}
        for n in (x.strip() for x in names if x.strip()):
            self.assertIn(n, exported_names)

    def test_globe_glass_and_renderer(self):
        g = read("globe.js")
        m = re.search(r"new THREE\.MeshPhysicalMaterial\(\{(.*?)\}\)", g, re.S)
        self.assertIsNotNone(m)
        body = m.group(1)
        for frag in ("transmission: 1", "ior: 1.5", "thickness: 0.2", "roughness: 0.05", "clearcoat: 1",
                     "depthWrite: false"):
            self.assertIn(frag, body)
        for word in ("ACESFilmicToneMapping", "SRGBColorSpace", "PMREMGenerator", "LatheGeometry",
                     "scene.background", "RoomEnvironment", "isWebGL2", "aSize"):
            self.assertIn(word, g)
        self.assertNotRegex(g, r"alpha\s*:\s*true")

    def test_service_worker_and_css(self):
        sw = read("sw.js")
        self.assertIn("/static/vendor/RoomEnvironment.js", sw)
        self.assertIn('"snowglobe-v4"', sw)  # bumped from v3: the shell now includes segment.js and the cut-out shape
        self.assertIn("38vh", read("style.css"))

    def test_hidden_attribute_wins_over_display_rules(self):
        css = re.sub(r"\s+", " ", read("style.css"))
        self.assertIn("[hidden] { display: none !important; }", css)

    def test_snow_visible_on_light_background(self):
        g = read("globe.js")
        self.assertIn("rgba(80,90,110,0.35)", g)
        self.assertEqual(g.count("0.065"), 2)
        self.assertIn("#cfcac2", g)
        self.assertIn("#e6e3de", g)

    def test_mound_and_base_dimensions(self):
        g = read("globe.js")
        const = lambda n: float(re.search(rf"const {n}\s*=\s*([0-9.]+)", g).group(1))
        self.assertGreaterEqual(const("MOUND_H"), 0.3)
        self.assertLessEqual(const("BASE_MAX_R"), 1.05 * const("R"))
        self.assertLessEqual(const("BASE_H_SCALE"), 0.8)

    def test_motion_pill_only_with_request_permission(self):
        a = read("app.js")
        self.assertEqual(a.count("motionBtn.hidden = false"), 1)
        branch = a.index("DeviceMotionEvent.requestPermission === \"function\"")
        self.assertLess(branch, a.index("motionBtn.hidden = false"))
        self.assertIn("hidden", re.search(r'<button id="motion"[^>]*>', read("index.html")).group(0))
        self.assertIn("border-radius: 999px", read("style.css"))

    def test_framing_for_phone_and_portrait_tablet(self):
        a, g = read("app.js"), read("globe.js")
        # panel.top limits the globe only for a full-width bottom sheet (375x812), not the 820x1180 side panel
        self.assertIn('matchMedia("(min-width:800px)")', a)
        self.assertIn("rect.top > stackBottom", a)
        self.assertIn("window.innerHeight", a)
        self.assertIn("MIN_BAND = 200", g)
        self.assertNotIn("Math.max(yBottom - yTop, 120)", g)
        self.assertIn("w / h < 0.8", g)  # 820/1180 = 0.69 uses the fitted camera

    def test_plaque_has_back_panel(self):
        g = read("globe.js")
        body = g[g.index("buildPhoto()"):g.index("shake(energy)")]
        self.assertIn("back.rotation.y = Math.PI", body)
        self.assertIn("plaque.add(frame, pic, back)", body)
        self.assertNotIn("MeshPhongMaterial({ color: 0xf2e6c9", body)

    def test_vendor_script_fetches_room_environment(self):
        s = (STATIC.parent.parent / "scripts" / "vendor-three.sh").read_text()
        self.assertIn("RoomEnvironment.js", s)
        self.assertIn("./three.module.min.js", s)


if __name__ == "__main__":
    unittest.main()
