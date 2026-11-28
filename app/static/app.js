import * as THREE from "./vendor/three.module.min.js";
import { Globe } from "./globe.js";
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
  const panelShown = getComputedStyle(panel).display !== "none";
  return {
    top: $("stack").getBoundingClientRect().bottom,
    bottom: panelShown ? panel.getBoundingClientRect().top : window.innerHeight,
  };
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
let photoBlob = null;

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
    $(id).addEventListener("input", () => applyConfig(readConfig()));
  }
  $("photo").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return status("errType");
    try {
      const { canvas, blob } = await resizePhoto(file);
      photoBlob = blob;
      globe.setTexture(new THREE.CanvasTexture(canvas));
      $("share").disabled = false;
      status("");
    } catch { status("errGeneric"); }
  });
  $("share").addEventListener("click", async () => {
    if (!photoBlob) return;
    $("share").disabled = true;
    status("uploading");
    try {
      const q = encodeURIComponent(JSON.stringify(readConfig()));
      const res = await fetch(`${BASE}/api/globes?config=${q}`, {
        method: "POST", headers: { "Content-Type": photoBlob.type }, body: photoBlob,
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
