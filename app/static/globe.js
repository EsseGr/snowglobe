import * as THREE from "./vendor/three.module.min.js";
import { RoomEnvironment } from "./vendor/RoomEnvironment.js";

const R = 1.5;          // glass radius
const FLOOR = -1.05;    // y of the snow bed (flat edge of the mound)
const MAX_SNOW = 3000;
const MOUND_R = 1.05;   // radius of the snow mound
const MOUND_H = 0.19;   // height of the mound at its centre
const BASE_TOP = FLOOR - 0.1;
const BASE_BOTTOM = -2.05;

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
  const [c, g] = canvas2d(32, 32);
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
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
const PROFILES = {
  collar: [[1.2, -1.4], [1.38, -1.4], [1.42, -1.36], [1.42, -1.19], [1.38, BASE_TOP], [1.2, BASE_TOP]],
  body: [[0, -1.85], [1.7, -1.85], [1.62, -1.75], [1.48, -1.45], [1.25, -1.4], [1.2, -1.36], [1.18, BASE_TOP], [0, BASE_TOP]],
  foot: [[0, BASE_BOTTOM], [1.76, BASE_BOTTOM], [1.82, -2.0], [1.82, -1.9], [1.76, -1.85], [0, -1.85]],
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
  const q = Math.sqrt(k);
  return FLOOR + MOUND_H * q + 0.06 * (valueNoise(x * 3, z * 3) - 0.5) * q;
}

function moundGeometry() {
  const geo = new THREE.SphereGeometry(MOUND_R, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, mound(p.getX(i), p.getZ(i)) - FLOOR);
  geo.computeVertexNormals();
  return geo;
}

function backgroundTexture() {
  const [c, g] = canvas2d(4, 256);
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#eceff4");
  grad.addColorStop(1, "#b8bec9");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
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

    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.2),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, toneMapped: false }));
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
    for (let i = 0; i < MAX_SNOW; i++) {
      const p = this.randomInside();
      this.pos.set(p, i * 3);
      sizes[i] = 0.5 + Math.random() * 1.1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.snowMat = new THREE.PointsMaterial({ size: 0.05, map: dotTexture(), transparent: true,
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
    this.snowMat.size = 0.05 * size;
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
    this.shape = shape === "sphere" ? "sphere" : "plaque";
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
    if (!this.texture) return;
    const img = this.texture.image;
    const aspect = img && img.width && img.height ? img.width / img.height : 1;
    // toneMapped:false keeps the photo's colours as uploaded (ACES would wash them out).
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    if (this.shape === "sphere") {
      this.photoMesh = new THREE.Mesh(new THREE.SphereGeometry(0.75, 48, 32), mat);
      this.photoMesh.position.y = 0.1;
    } else {
      const w = aspect >= 1 ? 1.7 : 1.3 * aspect;
      const h = aspect >= 1 ? 1.7 / aspect : 1.3;
      const plaque = new THREE.Group();
      const pic = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      pic.position.z = 0.03;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, h + 0.12, 0.05),
        new THREE.MeshPhongMaterial({ color: 0xf2e6c9, shininess: 60 }));
      plaque.add(frame, pic);
      plaque.position.y = 0.1;
      this.photoMesh = plaque;
    }
    this.group.add(this.photoMesh);
  }

  shake(energy) {
    energy = Math.min(energy, 3);
    const n = this.points.geometry.drawRange.count;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      this.vel[k] += (Math.random() - 0.5) * 4 * energy;
      this.vel[k + 1] += (Math.random() * 3 + 0.5) * energy;
      this.vel[k + 2] += (Math.random() - 0.5) * 4 * energy;
    }
  }

  bindPointer(canvas) {
    let down = false, lx = 0, ly = 0;
    canvas.addEventListener("pointerdown", (e) => { down = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
    const end = () => { down = false; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this.spin += dx * 0.01;
      this.group.rotation.x = Math.max(-0.5, Math.min(0.5, this.group.rotation.x + dy * 0.005));
      const speed = Math.hypot(dx, dy);
      if (speed > 12) this.shake(Math.min(speed / 40, 1.5));
    });
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = 40;
    if (w / h < 0.8) {
      // Mobile: fit the globe + base (about 3.8 x 4.4 units) in the top 60% of the screen,
      // centred at ~30% from the top.
      const t = Math.tan((this.camera.fov * Math.PI) / 360);
      const d = Math.max(4.4 / (0.6 * 2 * t), 3.8 / (2 * t * this.camera.aspect));
      this.camera.position.set(0, 0.8, d);
      this.camera.lookAt(0, -0.3, 0);
      this.camera.setViewOffset(w, h, 0, 0.2 * h, w, h);
    } else {
      this.camera.clearViewOffset();
      this.camera.position.set(0, 0.3, 7.5);
      this.camera.lookAt(0, 0, 0);
    }
    this.camera.updateProjectionMatrix();
  }

  stepSnow(dt) {
    const n = this.points.geometry.drawRange.count;
    const drag = Math.exp(-1.8 * dt);
    const t = performance.now() * 0.001;
    const p = this.pos, v = this.vel;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      const near = p[k + 1] < FLOOR + 0.3;
      if (near && v[k] === 0 && v[k + 1] === 0 && v[k + 2] === 0 && p[k + 1] <= mound(p[k], p[k + 2])) continue;
      v[k + 1] -= 1.1 * dt;
      v[k] = v[k] * drag + Math.sin(t * 1.3 + i) * 0.02 * dt * 60;
      v[k + 1] *= drag;
      v[k + 2] = v[k + 2] * drag + Math.cos(t * 1.1 + i * 1.7) * 0.02 * dt * 60;
      p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
      if (p[k + 1] < FLOOR + 0.3) {
        const g = mound(p[k], p[k + 2]);
        if (p[k + 1] <= g) {
          p[k + 1] = g - Math.random() * 0.02;
          v[k] = v[k + 1] = v[k + 2] = 0;
        }
      }
      const r = Math.hypot(p[k], p[k + 1], p[k + 2]), lim = R - 0.08;
      if (r > lim) {
        const s = lim / r;
        p[k] *= s; p[k + 1] *= s; p[k + 2] *= s;
        v[k] *= -0.3; v[k + 1] *= -0.3; v[k + 2] *= -0.3;
      }
    }
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
