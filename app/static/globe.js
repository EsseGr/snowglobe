import * as THREE from "./vendor/three.module.min.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";

const R = 1.5;          // glass radius
const FLOOR = -1.05;    // y of the snow bed (flat edge of the mound)
const MAX_SNOW = 3000;
const MOUND_R = 1.05;   // radius of the snow mound
const MOUND_H = 0.35;   // height of the mound at its centre
const BASE_TOP = FLOOR - 0.1;
const BASE_MAX_R = 1.57;  // widest point of the base (1.05 x glass diameter / 2)
const BASE_H_SCALE = 0.8;
const BASE_BOTTOM = BASE_TOP - 0.9 * BASE_H_SCALE;
const NEAR_FLOOR = FLOOR + MOUND_H + 0.1;  // snow below this may touch the mound
const CUT_H = 0.55 * 2 * R;  // cut-out figures: ~55% of the inside height of the glass
const CUT_MAX_W = 2.2;        // widest figure that still fits inside the glass at shoulder height
const CUT_SINK = 0.08;        // feet are sunk this far into the snow
const CUT_LAYER = 0.016;      // spacing of the thickness layers
const CREAM = 0xd8c9a6;
const FIT_MARGIN = 16; // px kept free above and below the globe on narrow screens
const MIN_BAND = 200;   // px; a smaller free band falls back to the full window height

// Snow behaviour. Fall speed settles at about SNOW_GRAVITY / SNOW_DRAG (u/s); the glass is ~2.3 u of fall.
const SNOW_GRAVITY = 0.28;   // u/s^2 pulling a flake down
const SNOW_DRAG = 3;         // 1/s velocity damping ("glycerine")
const FALL_VARIATION = 0.3;  // each flake falls at 1 +- this of the nominal speed
const FLOW_STRENGTH = 0.24;  // u/s peak speed of the always-on convection current
const FLOW_SCALE = 2.1;      // spatial frequency of the current (rad/u)
const FLOW_DRIFT = 0.11;     // rad/s: how fast the current's pattern evolves
const LIFT_SLICE = 60;       // resting flakes are tested for lift-off 1/LIFT_SLICE per frame
const LIFT_MIN = 0.13;       // u/s upward current needed to lift a resting flake
const WOBBLE = 0.035;        // u/s sideways wobble of each flake
const STIR_STRENGTH = 1.6;   // u/s^2 push of the finger stir at full finger speed
const STIR_RADIUS = 0.7;     // u, reach of the finger stir inside the globe
const STIR_SPEED_REF = 1500; // px/s of finger speed that gives full stir strength
const SHAKE_IMPULSE = 1.7;   // scales the (global) shake kick to offset the higher drag

// Glass quality: fps thresholds for the fallback to a plain transparent material.
const FPS_MIN = 30;
const FPS_WARMUP_MS = 2000;
const FPS_WINDOW = 60;
const FPS_BAD_WINDOWS = 2;
const FPS_MAX_DT_MS = 250;

function canvas2d(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")];
}

function dotTexture() {
  // White flake with a soft grey outline so it stays visible on light backgrounds.
  const [c, g] = canvas2d(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,1)");
  grad.addColorStop(0.64, "rgba(80,90,110,0.35)");
  grad.addColorStop(0.82, "rgba(80,90,110,0.18)");
  grad.addColorStop(1, "rgba(80,90,110,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function srgb(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function repeat(tex, x, y) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(x, y);
  return tex;
}

// Grey noise canvas used as a roughness map (green channel is sampled).
function noiseTexture(base, spread, size = 128) {
  const [c, g] = canvas2d(size, size);
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, base + (Math.random() - 0.5) * spread));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return repeat(new THREE.CanvasTexture(c), 4, 2);
}

function walnutTexture() {
  const [c, g] = canvas2d(512, 256);
  g.fillStyle = "#4a2d1a";
  g.fillRect(0, 0, 512, 256);
  for (let y = 0; y < 256; y += 1) {
    const wave = Math.sin(y * 0.09) * 0.5 + Math.sin(y * 0.021 + 1.7) * 0.5;
    g.fillStyle = `rgba(${20 + wave * 18 + Math.random() * 10},${10 + wave * 8},4,${0.18 + Math.random() * 0.22})`;
    g.fillRect(0, y, 512, 1);
  }
  for (let i = 0; i < 60; i++) {
    g.strokeStyle = `rgba(15,7,2,${0.1 + Math.random() * 0.2})`;
    g.lineWidth = 0.6 + Math.random() * 1.4;
    const y0 = Math.random() * 256;
    g.beginPath();
    g.moveTo(0, y0);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, y0 + Math.sin(x * 0.02 + i) * 3 + (Math.random() - 0.5) * 1.5);
    g.stroke();
  }
  return repeat(srgb(new THREE.CanvasTexture(c)), 2, 1);
}

function marbleTexture() {
  const [c, g] = canvas2d(512, 256);
  g.fillStyle = "#ecebe8";
  g.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = `rgba(150,150,155,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * 512, Math.random() * 256, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  for (let i = 0; i < 14; i++) {
    let x = Math.random() * 512, y = Math.random() * 256;
    g.strokeStyle = `rgba(${90 + Math.random() * 40},${95 + Math.random() * 40},${105 + Math.random() * 40},${0.25 + Math.random() * 0.4})`;
    g.lineWidth = 0.5 + Math.random() * 1.8;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 24; s++) {
      x += 14 + Math.random() * 14;
      y += (Math.random() - 0.4) * 30;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  return repeat(srgb(new THREE.CanvasTexture(c)), 2, 1);
}

// name -> material factory. Each call returns fresh materials/textures so setBase can dispose them.
const MATERIALS = {
  walnut: () => new THREE.MeshStandardMaterial({ map: walnutTexture(), roughness: 0.55, metalness: 0,
    roughnessMap: noiseTexture(200, 60) }),
  marble: () => new THREE.MeshStandardMaterial({ map: marbleTexture(), roughness: 0.25, metalness: 0 }),
  gold: () => new THREE.MeshStandardMaterial({ color: 0xd4af37, metalness: 1, roughness: 0.3,
    roughnessMap: noiseTexture(230, 40) }),
  black: () => new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.1, roughness: 0.6,
    roughnessMap: noiseTexture(190, 110) }),
};

// Stored base value -> materials for [collar, body, foot]. "black" has no stored value (server whitelist).
const BASES = {
  wood: ["gold", "walnut", "black"],
  gold: ["gold", "gold", "black"],
  ice: ["gold", "marble", "black"],
};

// Lathe profiles (r, y), ascending along the outside, small chamfers/bevels on the edges.
// Authored for a base 1.82 wide; scaled so the widest point is BASE_MAX_R and the height is BASE_H_SCALE.
const BASE_SRC_R = 1.82;
const scaleBase = (pts) => pts.map(([r, y]) =>
  [r * (BASE_MAX_R / BASE_SRC_R), BASE_TOP + (y - BASE_TOP) * BASE_H_SCALE]);
const PROFILES = {
  collar: scaleBase([[1.2, -1.4], [1.38, -1.4], [1.42, -1.36], [1.42, -1.19], [1.38, BASE_TOP], [1.2, BASE_TOP]]),
  body: scaleBase([[0, -1.85], [1.7, -1.85], [1.62, -1.75], [1.48, -1.45], [1.25, -1.4], [1.2, -1.36], [1.18, BASE_TOP], [0, BASE_TOP]]),
  foot: scaleBase([[0, -2.05], [1.76, -2.05], [1.82, -2.0], [1.82, -1.9], [1.76, -1.85], [0, -1.85]]),
};

function latheFrom(points) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), 64);
}

function disposeMaterial(m) {
  for (const k of ["map", "roughnessMap"]) if (m[k]) m[k].dispose();
  m.dispose();
}

// Deterministic value noise and the shared height field of the snow mound.
function hash(ix, iz) {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function mound(x, z) {
  const k = 1 - (x * x + z * z) / (MOUND_R * MOUND_R);
  if (k <= 0) return FLOOR;
  // k^1.5: a round hill with zero slope at the rim; the noise fades out with k.
  return FLOOR + MOUND_H * k * Math.sqrt(k) + 0.06 * (valueNoise(x * 3, z * 3) - 0.5) * k;
}

function moundGeometry() {
  const geo = new THREE.SphereGeometry(MOUND_R, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, mound(p.getX(i), p.getZ(i)) - FLOOR);
  geo.computeVertexNormals();
  return geo;
}

function backgroundTexture() {
  const [c, g] = canvas2d(256, 256);
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 181);
  grad.addColorStop(0, "#cfcac2");
  grad.addColorStop(1, "#e6e3de");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return srgb(new THREE.CanvasTexture(c));
}

function shadowTexture() {
  const [c, g] = canvas2d(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.35)");
  grad.addColorStop(0.55, "rgba(0,0,0,0.18)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Same shape as the photo's alpha, filled with a flat colour (sides and back of a cut-out figure).
function silhouetteTexture(img, w, h) {
  const [c, g] = canvas2d(w, h);
  g.drawImage(img, 0, 0, w, h);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#" + CREAM.toString(16);
  g.fillRect(0, 0, w, h);
  return srgb(new THREE.CanvasTexture(c));
}

// Soft contact shadow draped over the snow mound (vertices follow the terrain).
function contactShadowGeometry(width, depth, z) {
  const geo = new THREE.PlaneGeometry(width, depth, 24, 8);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, mound(p.getX(i), p.getZ(i) + z) + 0.012);
  geo.translate(0, 0, z);
  return geo;
}

function physicalGlass() {
  return new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 1, ior: 1.5, thickness: 0.2,
    roughness: 0.05, clearcoat: 1, side: THREE.FrontSide, depthWrite: false });
}

function simpleGlass() {
  return new THREE.MeshPhongMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.14, specular: 0xffffff,
    shininess: 140, depthWrite: false });
}

export class Globe {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.scene = new THREE.Scene();
    this.scene.background = backgroundTexture();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    this.camera.position.set(0, 0.3, 7.5);
    this.camera.lookAt(0, 0, 0);

    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this.scene.environment = pmrem.fromScene(room, 0.04).texture;
      pmrem.dispose();
      room.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    } catch (err) {
      console.warn("environment map unavailable", err);
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    }
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.shadowTex = shadowTexture();
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 4.6),
      new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = BASE_BOTTOM + 0.005;
    this.group.add(shadow);

    this.glassMode = this.renderer.capabilities.isWebGL2 ? "physical" : "simple";
    this.glass = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32),
      this.glassMode === "physical" ? physicalGlass() : simpleGlass());
    this.glass.renderOrder = 3;
    this.group.add(this.glass);
    canvas.dataset.glass = this.glassMode;

    this.mound = new THREE.Mesh(moundGeometry(),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }));
    this.mound.position.y = FLOOR;
    this.group.add(this.mound);

    this.base = new THREE.Group();
    this.baseParts = ["collar", "body", "foot"].map((k) => {
      const m = new THREE.Mesh(latheFrom(PROFILES[k]));
      this.base.add(m);
      return m;
    });
    this.group.add(this.base);
    this.setBase("wood");

    this.photoMesh = null;
    this.texture = null;
    this.shape = "plaque";
    this.initSnow();

    this.shakeEnergy = 0;
    // Finger stir: position/direction in the group's local space; power decays when the finger slows down.
    this.stir = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, power: 0 };
    this.spin = 0;
    this.last = performance.now();
    this.perfReset(this.last);
    this.resize();
    window.addEventListener("resize", () => { this.perfReset(performance.now()); this.resize(); });
    document.addEventListener("visibilitychange", () => this.perfReset(performance.now()));
    this.bindPointer(canvas);
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  setGlassMode(mode) {
    if (mode === this.glassMode) return;
    const old = this.glass.material;
    this.glass.material = mode === "physical" ? physicalGlass() : simpleGlass();
    old.dispose();
    this.glassMode = mode;
    this.canvas.dataset.glass = mode;
  }

  perfReset(now) {
    this.last = now;
    this.perf = { warmUntil: now + FPS_WARMUP_MS, n: 0, sum: 0, bad: 0 };
  }

  // Degrades to the simple glass after two consecutive slow windows; never goes back.
  perfTick(rawMs, now) {
    const p = this.perf;
    if (this.glassMode !== "physical" || now < p.warmUntil || rawMs <= 0 || rawMs > FPS_MAX_DT_MS) return;
    p.n++; p.sum += rawMs;
    if (p.n < FPS_WINDOW) return;
    const fps = (1000 * p.n) / p.sum;
    p.n = 0; p.sum = 0;
    p.bad = fps < FPS_MIN ? p.bad + 1 : 0;
    if (p.bad >= FPS_BAD_WINDOWS) this.setGlassMode("simple");
  }

  initSnow() {
    this.pos = new Float32Array(MAX_SNOW * 3);
    this.vel = new Float32Array(MAX_SNOW * 3);
    const sizes = new Float32Array(MAX_SNOW);
    this.fall = new Float32Array(MAX_SNOW);   // per-flake fall speed factor
    this.phase = new Float32Array(MAX_SNOW);  // per-flake wobble phase
    this.liftAt = 0;
    for (let i = 0; i < MAX_SNOW; i++) {
      const p = this.randomInside();
      this.pos.set(p, i * 3);
      sizes[i] = 0.5 + Math.random() * 1.1;
      this.fall[i] = 1 + (Math.random() * 2 - 1) * FALL_VARIATION;
      this.phase[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.snowMat = new THREE.PointsMaterial({ size: 0.065, map: dotTexture(), transparent: true,
      depthWrite: false, sizeAttenuation: true });
    this.snowMat.onBeforeCompile = (shader) => {
      shader.vertexShader = "attribute float aSize;\n" + shader.vertexShader.replace(
        "#include <logdepthbuf_vertex>", "gl_PointSize *= aSize;\n#include <logdepthbuf_vertex>");
    };
    this.points = new THREE.Points(geo, this.snowMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.group.add(this.points);
    this.setSnow({ amount: 800, size: 1, color: "#ffffff" });
  }

  randomInside() {
    for (;;) {
      const x = (Math.random() * 2 - 1) * (R - 0.1);
      const y = FLOOR + Math.random() * (R + 1.0);
      const z = (Math.random() * 2 - 1) * (R - 0.1);
      if (x * x + y * y + z * z < (R - 0.1) ** 2) return [x, y, z];
    }
  }

  setSnow({ amount, size, color }) {
    this.points.geometry.setDrawRange(0, Math.min(amount, MAX_SNOW));
    this.snowMat.size = 0.065 * size;
    this.snowMat.color.set(color);
    this.snowMat.needsUpdate = true;
  }

  setBase(name) {
    const names = BASES[name] || BASES.wood;
    this.baseParts.forEach((mesh, i) => {
      const old = mesh.material;
      mesh.material = MATERIALS[names[i]]();
      if (old) disposeMaterial(old);
    });
  }

  setShape(shape) {
    this.shape = shape === "sphere" || shape === "cutout" ? shape : "plaque";
    this.buildPhoto();
  }

  setTexture(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    if (this.texture) this.texture.dispose();
    this.texture = tex;
    this.buildPhoto();
  }

  buildPhoto() {
    if (this.photoMesh) {
      this.group.remove(this.photoMesh);
      this.photoMesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o !== this.photoMesh) o.material.dispose(); });
      this.photoMesh.material && this.photoMesh.material.dispose();
      this.photoMesh = null;
    }
    if (this.silTex) { this.silTex.dispose(); this.silTex = null; }
    if (!this.texture) return;
    const img = this.texture.image;
    const aspect = img && img.width && img.height ? img.width / img.height : 1;
    if (this.shape === "cutout") {
      this.photoMesh = this.buildCutout(img, aspect);
      this.group.add(this.photoMesh);
      return;
    }
    // toneMapped:false keeps the photo's colours as uploaded (ACES would wash them out).
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    const top = mound(0, 0);  // the figure stands on the crest of the snow mound
    if (this.shape === "sphere") {
      this.photoMesh = new THREE.Mesh(new THREE.SphereGeometry(0.75, 48, 32), mat);
      this.photoMesh.position.y = top + 0.75 - 0.1;
    } else {
      const w = aspect >= 1 ? 1.7 : 1.3 * aspect;
      const h = aspect >= 1 ? 1.7 / aspect : 1.3;
      const plaque = new THREE.Group();
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      pic.position.z = 0.03;
      // Standard material (not Phong) so the frame picks up the environment map from behind too.
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.05),
        new THREE.MeshStandardMaterial({ color: 0xf2e6c9, roughness: 0.6, metalness: 0 }));
      const back = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.08, h + 0.08),
        new THREE.MeshStandardMaterial({ color: 0xd8c9a6, roughness: 0.9, metalness: 0 }));
      back.rotation.y = Math.PI;
      back.position.z = -0.026;
      plaque.add(frame, pic, back);
      plaque.position.y = top - 0.03 + (h + 0.12) / 2;
      this.photoMesh = plaque;
    }
    this.group.add(this.photoMesh);
  }

  // A flat figure with a little thickness: photo layer in front, cream silhouette layers behind it
  // (so the back of the figure is a plain cream cut-out), feet sunk into the snow, soft shadow on the mound.
  buildCutout(img, aspect) {
    const h = Math.min(CUT_H, CUT_MAX_W / aspect), w = h * aspect;
    const bottom = mound(0, 0) - CUT_SINK, cy = bottom + h / 2;
    const tex = this.texture;
    // Mipmaps would bleed the transparent pixels' colour into the edges.
    if (tex.generateMipmaps || tex.minFilter !== THREE.LinearFilter) {
      tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    }
    const cut = { alphaTest: 0.5, alphaToCoverage: true };
    this.silTex = silhouetteTexture(img, Math.max(1, img.width || 256), Math.max(1, img.height || 256));
    this.silTex.generateMipmaps = false; this.silTex.minFilter = THREE.LinearFilter;
    const cream = () => new THREE.MeshStandardMaterial({ map: this.silTex, roughness: 0.9, metalness: 0,
      side: THREE.DoubleSide, ...cut });
    const geo = () => new THREE.PlaneGeometry(w, h);
    const front = new THREE.Mesh(geo(), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, ...cut }));
    front.position.set(0, cy, CUT_LAYER);
    const mid = new THREE.Mesh(geo(), cream());
    mid.position.set(0, cy, 0);
    const back = new THREE.Mesh(geo(), cream());
    back.position.set(0, cy, -CUT_LAYER);
    const shadow = new THREE.Mesh(contactShadowGeometry(Math.min(w * 1.1, 2 * MOUND_R), 0.55, 0.04),
      new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    const fig = new THREE.Group();
    fig.add(shadow, back, mid, front);
    return fig;
  }

  shake(energy) {
    energy = Math.min(energy, 3);
    const n = this.points.geometry.drawRange.count;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      this.vel[k] += (Math.random() - 0.5) * 4 * energy * SHAKE_IMPULSE;
      this.vel[k + 1] += (Math.random() * 3 + 0.5) * energy * SHAKE_IMPULSE;
      this.vel[k + 2] += (Math.random() - 0.5) * 4 * energy * SHAKE_IMPULSE;
    }
  }

  // Stir the snow where the finger is: project the screen point into the globe (middle of the chord
  // where the camera ray crosses the glass) and aim a local vortex along the finger's motion.
  stirAt(clientX, clientY, dx, dy, speed) {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.camera.updateMatrixWorld();
    this.group.updateMatrixWorld();
    const o = this.camera.position.clone();
    const d = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(this.camera).sub(o).normalize();
    const c = this.group.getWorldPosition(new THREE.Vector3());
    const oc = o.clone().sub(c);
    const b = oc.dot(d), disc = b * b - (oc.dot(oc) - R * R);
    // Ray misses the glass: aim at the closest point of the ray to the centre, pulled inside.
    const tMid = -b;
    const hit = o.clone().addScaledVector(d, tMid);
    const off = hit.clone().sub(c);
    if (disc < 0 && off.length() > R * 0.9) hit.copy(c).addScaledVector(off.normalize(), R * 0.9);
    this.group.worldToLocal(hit);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const dir = right.multiplyScalar(dx).addScaledVector(up, -dy);
    dir.applyQuaternion(this.group.quaternion.clone().invert());
    if (dir.lengthSq() > 0) dir.normalize();
    const s = this.stir;
    s.x = hit.x; s.y = hit.y; s.z = hit.z;
    s.dx = dir.x; s.dy = dir.y; s.dz = dir.z;
    s.power = Math.max(s.power, Math.min(speed / STIR_SPEED_REF, 1.5) * STIR_STRENGTH);
  }

  // One pointer stirs the snow under it; two fingers (or right button / shift + drag) rotate the globe.
  bindPointer(canvas) {
    const pointers = new Map();
    let rx = 0, ry = 0;  // reference point of the rotation (centroid of the pointers)
    const centroid = () => {
      let x = 0, y = 0;
      for (const p of pointers.values()) { x += p.x; y += p.y; }
      return [x / pointers.size, y / pointers.size];
    };
    const rotating = () => pointers.size >= 2 || [...pointers.values()].some((p) => p.rotate);
    const reset = () => { if (pointers.size) [rx, ry] = centroid(); };
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp, rotate: e.button === 2 || e.shiftKey });
      canvas.setPointerCapture(e.pointerId);
      reset();
    });
    const end = (e) => { pointers.delete(e.pointerId); reset(); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      const dt = Math.max(e.timeStamp - p.t, 1);
      p.x = e.clientX; p.y = e.clientY; p.t = e.timeStamp;
      if (rotating()) {
        const [cx, cy] = centroid();
        this.spin += (cx - rx) * 0.01;
        this.group.rotation.x = Math.max(-0.5, Math.min(0.5, this.group.rotation.x + (cy - ry) * 0.005));
        rx = cx; ry = cy;
      } else if (dx || dy) {
        this.stirAt(e.clientX, e.clientY, dx, dy, Math.hypot(dx, dy) / dt * 1000);
      }
    });
  }

  // Vertical band (px) of the window free for the globe; set by the page layout (title, hint, panel).
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = 40;
    this.camera.clearViewOffset();
    if (w / h < 0.8) {
      const { top, bottom } = this.insets ? this.insets() : { top: 90, bottom: 0.62 * h };
      this.fitCamera(w, h, top + FIT_MARGIN, bottom - FIT_MARGIN);
    } else {
      this.camera.position.set(0, 0.3, 7.5);
      this.camera.lookAt(0, 0, 0);
    }
    this.camera.updateProjectionMatrix();
  }

  // Narrow screens: find the camera distance at which the glass + base fit between yTop and yBottom (px),
  // projecting the real extreme points so perspective is accounted for, then shift the view into the band.
  fitCamera(w, h, yTop, yBottom) {
    const cam = this.camera, v = new THREE.Vector3();
    const pts = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push([0, R * Math.sin(a), R * Math.cos(a)], [R * Math.cos(a), 0, R * Math.sin(a)]);
      pts.push([BASE_MAX_R * Math.cos(a), BASE_BOTTOM, BASE_MAX_R * Math.sin(a)]);
    }
    const place = (d) => {
      cam.position.set(0, 0.8, d);
      cam.lookAt(0, -0.2, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      let minY = Infinity, maxY = -Infinity, maxX = 0;
      for (const [x, y, z] of pts) {
        v.set(x, y, z).project(cam);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); maxX = Math.max(maxX, Math.abs(v.x));
      }
      return { spanPx: ((maxY - minY) / 2) * h, halfWPx: maxX * (w / 2), midPx: ((1 - (maxY + minY) / 2) / 2) * h };
    };
    if (yBottom - yTop < MIN_BAND) { yTop = FIT_MARGIN; yBottom = h - FIT_MARGIN; } // band too small: use full height
    const availH = yBottom - yTop, availW = w - 2 * FIT_MARGIN;
    let lo = 4, hi = 40;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2, m = place(mid);
      if (m.spanPx <= availH && m.halfWPx * 2 <= availW) hi = mid; else lo = mid;
    }
    const m = place(hi);
    // Positive offset moves the picture up on screen.
    cam.setViewOffset(w, h, 0, m.midPx - (yTop + availH / 2), w, h);
  }

  stepSnow(dt) {
    const n = this.points.geometry.drawRange.count;
    const drag = Math.exp(-SNOW_DRAG * dt), pull = 1 - drag;
    const t = performance.now() * 0.001;
    const p = this.pos, v = this.vel, fall = this.fall, phase = this.phase;
    // Convection current: two counter-rotating cells (divergence-free), pattern drifting with time.
    const f1 = t * FLOW_DRIFT, f2 = t * FLOW_DRIFT * 0.77 + 1.3, s = FLOW_SCALE;
    const st = this.stir;
    const stirOn = st.power > 0.02;
    const sr2 = STIR_RADIUS * STIR_RADIUS;
    const lift = (i) => {  // wake a resting flake just above the snow
      const k = i * 3;
      p[k + 1] = mound(p[k], p[k + 2]) + 0.02;
      v[k + 1] = 0.02;
    };
    // Slowly sweep the resting flakes and lift those that sit in a strong updraught.
    const m = Math.min(n, MAX_SNOW);
    const slice = Math.ceil(m / LIFT_SLICE);
    for (let j = 0; j < slice; j++) {
      const i = (this.liftAt + j) % m, k = i * 3;
      if (v[k] !== 0 || v[k + 1] !== 0 || v[k + 2] !== 0 || p[k + 1] >= NEAR_FLOOR) continue;
      const a = s * p[k] + 0.8 * p[k + 2] + f1, b = s * p[k + 1] + f2;
      if (-FLOW_STRENGTH * Math.cos(a) * Math.sin(b) > LIFT_MIN) lift(i);
    }
    this.liftAt = (this.liftAt + slice) % m;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      const near = p[k + 1] < NEAR_FLOOR;
      const resting = near && v[k] === 0 && v[k + 1] === 0 && v[k + 2] === 0 && p[k + 1] <= mound(p[k], p[k + 2]);
      let sx = 0, sy = 0, sz = 0;
      if (stirOn) {
        const ox = p[k] - st.x, oy = p[k + 1] - st.y, oz = p[k + 2] - st.z;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 < sr2) {
          const w = (1 - Math.sqrt(d2) / STIR_RADIUS) * st.power;
          // push along the finger's motion plus a swirl (dir x offset) around it
          sx = (st.dx + (st.dy * oz - st.dz * oy) * 2) * w;
          sy = (st.dy + (st.dz * ox - st.dx * oz) * 2) * w;
          sz = (st.dz + (st.dx * oy - st.dy * ox) * 2) * w;
          if (resting) { lift(i); sy += w; }
        }
      }
      if (resting && !(sx || sy || sz)) continue;
      const a = s * p[k] + 0.8 * p[k + 2] + f1, b = s * p[k + 1] + f2;
      const fy = fall[i];
      const flowX = FLOW_STRENGTH * Math.sin(a) * Math.cos(b);
      const flowY = -FLOW_STRENGTH * Math.cos(a) * Math.sin(b);
      const flowZ = 0.5 * FLOW_STRENGTH * Math.sin(s * p[k + 2] + f1 + p[k + 1]);
      const ang = t * (0.9 + 0.5 * fy) + phase[i];
      v[k + 1] -= SNOW_GRAVITY * fy * dt;
      v[k] = v[k] * drag + (flowX + Math.sin(ang) * WOBBLE) * pull + sx * dt;
      v[k + 1] = v[k + 1] * drag + flowY * pull + sy * dt;
      v[k + 2] = v[k + 2] * drag + (flowZ + Math.cos(ang) * WOBBLE) * pull + sz * dt;
      p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
      if (p[k + 1] < NEAR_FLOOR) {
        const g = mound(p[k], p[k + 2]);
        if (p[k + 1] <= g) {
          p[k + 1] = g - Math.random() * 0.02;
          v[k] = v[k + 1] = v[k + 2] = 0;
        }
      }
      const r = Math.hypot(p[k], p[k + 1], p[k + 2]), lim = R - 0.08;
      if (r > lim) {
        const sc = lim / r;
        p[k] *= sc; p[k + 1] *= sc; p[k + 2] *= sc;
        v[k] *= -0.3; v[k + 1] *= -0.3; v[k + 2] *= -0.3;
      }
    }
    st.power *= Math.exp(-5 * dt);
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  frame(now) {
    const raw = now - this.last;
    const dt = Math.min(raw / 1000, 0.05);
    this.last = now;
    this.perfTick(raw, now);
    this.group.rotation.y += this.spin;
    this.spin *= 0.92;
    if (this.photoMesh && this.shape === "sphere") this.photoMesh.rotation.y += dt * 0.4;
    this.stepSnow(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
