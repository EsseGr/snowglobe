import * as THREE from "./vendor/three.module.min.js";
import { Globe } from "./globe.js";
import { cutOut } from "./segment.js";
import { LANGS, pickLang, setLang, t } from "./i18n.js";

const meta = (n) => document.querySelector(`meta[name="${n}"]`).content;
const BASE = meta("sg-base");
const VIEW_ID = meta("sg-view");
const $ = (id) => document.getElementById(id);

function webglOk() {
  try {
    return !!document.createElement("canvas").getContext("webgl2") ||
      !!document.createElement("canvas").getContext("webgl");
  } catch { return false; }
}

// ---- i18n ----------------------------------------------------------------
const langSel = $("lang");
for (const [code, dict] of Object.entries(LANGS)) {
  const o = document.createElement("option");
  o.value = code; o.textContent = dict._name;
  langSel.appendChild(o);
}
const lang = pickLang(meta("sg-lang"));
langSel.value = lang;
setLang(lang);
langSel.addEventListener("change", () => setLang(langSel.value));

const status = (key) => { $("status").textContent = key ? t(key) : ""; };

if (!webglOk()) {
  $("status").textContent = t("errWebgl");
  throw new Error("no webgl");
}

const globe = new Globe($("stage"));

// Free band for the globe on narrow screens: below the title/hint/motion pill, above the panel.
globe.insets = () => {
  const panel = $("panel");
  const stackBottom = $("stack").getBoundingClientRect().bottom;
  const rect = panel.getBoundingClientRect();
  const panelShown = getComputedStyle(panel).display !== "none";
  // Only a full-width bottom sheet limits the globe; the side panel (>=800px wide) does not.
  const bottomSheet = panelShown && !window.matchMedia("(min-width:800px)").matches && rect.top > stackBottom;
  return { top: stackBottom, bottom: bottomSheet ? rect.top : window.innerHeight };
};
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => globe.resize());
  ro.observe($("stack"));
  ro.observe($("panel"));
}

// ---- shake sensors -------------------------------------------------------
function startMotion() {
  let last = 0;
  window.addEventListener("devicemotion", (e) => {
    const a = e.acceleration || e.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0) - (e.acceleration ? 0 : 9.8);
    const now = performance.now();
    if (mag > 8 && now - last > 150) { last = now; globe.shake(mag / 12); }
  });
}
const motionBtn = $("motion");
if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
  motionBtn.hidden = false;
  motionBtn.addEventListener("click", async () => {
    try {
      if ((await DeviceMotionEvent.requestPermission()) === "granted") { startMotion(); motionBtn.hidden = true; }
    } catch { /* user declined */ }
  });
} else if (typeof DeviceMotionEvent !== "undefined") {
  startMotion();
}

// ---- settings ------------------------------------------------------------
function readConfig() {
  return {
    shape: $("shape").value,
    base: $("base").value,
    snow: { amount: +$("amount").value, size: +$("size").value, color: $("color").value },
  };
}
function applyConfig(c) {
  globe.setShape(c.shape);
  globe.setBase(c.base);
  globe.setSnow(c.snow);
}
function placeholder() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#2a4a9a"); grad.addColorStop(1, "#9ec3ff");
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// ---- view mode -----------------------------------------------------------
async function initView() {
  document.body.classList.add("view");
  try {
    const res = await fetch(`${BASE}/api/globes/${encodeURIComponent(VIEW_ID)}`);
    if (!res.ok) throw new Error(String(res.status));
    const { config } = await res.json();
    globe.setTexture(await new THREE.TextureLoader().loadAsync(`${BASE}/api/globes/${encodeURIComponent(VIEW_ID)}/photo`));
    applyConfig(config);
  } catch {
    document.body.classList.remove("view");
    $("panel").hidden = true;
    $("status").textContent = t("errNotFound");
    $("hint").textContent = t("errNotFound");
  }
}

// ---- editor mode ---------------------------------------------------------
const MAX_DIM = 1280;
const CUT_MAX_BYTES = 4.5 * 1024 * 1024;  // stay under the server's default 5 MB limit
let photoBlob = null;
let photoCanvas = null;               // the whole photo (plaque / sphere)
let cutCanvas = null, cutBlob = null; // the people only, with alpha (cutout shape)
let job = 0;                          // identifies the latest photo, so a slow cut-out of an older one is dropped

// WebP with alpha; browsers that cannot encode WebP return PNG from toBlob on their own.
// Shrinks the picture until it fits under the upload limit.
async function encodeCutout(canvas) {
  let c = canvas, blob = null;
  for (let i = 0; i < 4; i++) {
    blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.9));
    if (!blob) throw new Error("encode");
    if (blob.size <= CUT_MAX_BYTES) break;
    const n = document.createElement("canvas");
    n.width = Math.max(1, Math.round(c.width * 0.75)); n.height = Math.max(1, Math.round(c.height * 0.75));
    n.getContext("2d").drawImage(c, 0, 0, n.width, n.height);
    c = n;
  }
  return blob;
}

// Shows the picture that belongs to the selected shape: the cut-out for "cutout", the whole photo otherwise.
function showPhoto() {
  const shape = $("shape").value;
  globe.setShape(shape);
  globe.setTexture(new THREE.CanvasTexture(shape === "cutout" && cutCanvas ? cutCanvas : photoCanvas));
}

function setCutoutAvailable(on) {
  $("shape").querySelector('option[value="cutout"]').disabled = !on;
}

async function resizePhoto(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  return { canvas: c, blob };
}

function initEditor() {
  globe.setTexture(placeholder());
  applyConfig(readConfig());
  for (const id of ["shape", "base", "amount", "size", "color"]) {
    $(id).addEventListener("input", () => {
      if (id === "shape" && photoCanvas) showPhoto(); else applyConfig(readConfig());
    });
  }
  $("photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return status("errType");
    const mine = ++job;
    try {
      const { canvas, blob } = await resizePhoto(file);
      if (mine !== job) return;
      photoBlob = blob; photoCanvas = canvas; cutCanvas = cutBlob = null;
      setCutoutAvailable(false);
      if ($("shape").value === "cutout") $("shape").value = "plaque";
      showPhoto();
      $("share").disabled = true;  // until we know whether this becomes a cut-out
      status("segmenting");
      await new Promise((r) => setTimeout(r, 50));  // let the message paint before the heavy work
      let cut = null;
      try {
        cut = await cutOut(canvas, BASE);
        if (cut) cutBlob = await encodeCutout(cut.canvas);
      } catch (err) {
        console.warn("cut-out failed", err);
        if (mine === job) { $("share").disabled = false; status("errGeneric"); }
        return;  // the plaque with the original photo stays
      }
      if (mine !== job) return;
      $("share").disabled = false;
      if (!cut) { status("noPeople"); return; }
      cutCanvas = cut.canvas;
      setCutoutAvailable(true);
      $("shape").value = "cutout";
      showPhoto();
      status("");
    } catch { if (mine === job) status("errGeneric"); }
  });
  $("share").addEventListener("click", async () => {
    const cutShape = readConfig().shape === "cutout" && cutBlob;
    const body = cutShape ? cutBlob : photoBlob;
    if (!body) return;
    $("share").disabled = true;
    status("uploading");
    try {
      const q = encodeURIComponent(JSON.stringify(readConfig()));
      const res = await fetch(`${BASE}/api/globes?config=${q}`, {
        method: "POST", headers: { "Content-Type": body.type }, body,
      });
      if (!res.ok) throw new Error(String(res.status));
      const { url } = await res.json();
      $("link").value = new URL(url, location.origin).href;
      $("result").hidden = false;
      status("done");
    } catch (err) {
      const code = +err.message;
      status(code === 413 ? "errTooLarge" : code === 415 ? "errType" : code === 429 ? "errRate" : "errGeneric");
    }
    $("share").disabled = false;
  });
  $("copy").addEventListener("click", async () => {
    $("link").select();
    try { await navigator.clipboard.writeText($("link").value); status("copied"); } catch { document.execCommand("copy"); }
  });
}

if (VIEW_ID) initView(); else initEditor();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch(() => {});
}
