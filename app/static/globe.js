import * as THREE from "./vendor/three.module.min.js";

const R = 1.5;          // glass radius
const FLOOR = -1.05;    // y of the snow bed
const MAX_SNOW = 3000;

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

function woodTexture() {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#6b4423";
  g.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(${30 + Math.random() * 40},${15 + Math.random() * 20},5,${0.15 + Math.random() * 0.2})`;
    g.fillRect(0, Math.random() * 64, 256, 1 + Math.random() * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const BASES = {
  wood: () => new THREE.MeshPhongMaterial({ map: woodTexture(), specular: 0x332211, shininess: 25 }),
  gold: () => new THREE.MeshPhongMaterial({ color: 0xd4af37, specular: 0xffeeaa, shininess: 90 }),
  ice: () => new THREE.MeshPhongMaterial({ color: 0xbfe8ff, specular: 0xffffff, shininess: 110, transparent: true, opacity: 0.8 }),
};

export class Globe {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    this.camera.position.set(0, 0.3, 7.5);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);
    const rim = new THREE.PointLight(0x88aaff, 40, 0, 2);
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 32),
      new THREE.MeshPhongMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.14, specular: 0xffffff,
        shininess: 140, depthWrite: false })
    );
    glass.renderOrder = 3;
    this.group.add(glass);

    this.base = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.8, 0.9, 48), BASES.wood());
    this.base.position.y = FLOOR - 0.45 - 0.1;
    this.group.add(this.base);

    this.photoMesh = null;
    this.texture = null;
    this.shape = "plaque";
    this.initSnow();

    this.shakeEnergy = 0;
    this.spin = 0;
    this.last = performance.now();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.bindPointer(canvas);
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  initSnow() {
    this.pos = new Float32Array(MAX_SNOW * 3);
    this.vel = new Float32Array(MAX_SNOW * 3);
    for (let i = 0; i < MAX_SNOW; i++) {
      const p = this.randomInside();
      this.pos.set(p, i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.snowMat = new THREE.PointsMaterial({ size: 0.05, map: dotTexture(), transparent: true,
      depthWrite: false, sizeAttenuation: true });
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
    const old = this.base.material;
    this.base.material = (BASES[name] || BASES.wood)();
    if (old.map) old.map.dispose();
    old.dispose();
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
    const mat = new THREE.MeshBasicMaterial({ map: this.texture });
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
    this.camera.fov = w / h < 0.8 ? 55 : 40;
    this.camera.position.y = w / h < 0.8 ? 1.2 : 0.3;
    this.camera.lookAt(0, w / h < 0.8 ? 0.6 : 0, 0);
    this.camera.updateProjectionMatrix();
  }

  stepSnow(dt) {
    const n = this.points.geometry.drawRange.count;
    const drag = Math.exp(-1.8 * dt);
    const t = performance.now() * 0.001;
    const p = this.pos, v = this.vel;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      if (p[k + 1] <= FLOOR && v[k] === 0 && v[k + 1] === 0 && v[k + 2] === 0) continue;
      v[k + 1] -= 1.1 * dt;
      v[k] = v[k] * drag + Math.sin(t * 1.3 + i) * 0.02 * dt * 60;
      v[k + 1] *= drag;
      v[k + 2] = v[k + 2] * drag + Math.cos(t * 1.1 + i * 1.7) * 0.02 * dt * 60;
      p[k] += v[k] * dt; p[k + 1] += v[k + 1] * dt; p[k + 2] += v[k + 2] * dt;
      if (p[k + 1] <= FLOOR) {
        p[k + 1] = FLOOR - Math.random() * 0.02;
        v[k] = v[k + 1] = v[k + 2] = 0;
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
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.group.rotation.y += this.spin;
    this.spin *= 0.92;
    if (this.photoMesh && this.shape === "sphere") this.photoMesh.rotation.y += dt * 0.4;
    this.stepSnow(dt);
    this.renderer.render(this.scene, this.camera);
  }
}
