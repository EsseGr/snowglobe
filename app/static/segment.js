// Cuts the people out of a photo, entirely in the browser (MediaPipe selfie segmentation, main thread).
// The runtime and model are vendored under static/vendor/mediapipe and loaded lazily, on first use only.

const PERSON_CLASSES = [1, 2, 3, 4, 5];  // hair, body-skin, face-skin, clothes, others (0 = background)
const MIN_COVERAGE = 0.03;   // less of the picture than this -> "no people"
const KEEP_RATIO = 0.2;      // keep components at least this big relative to the largest one...
const MIN_PIECE = 0.005;     // ...and at least this fraction of the picture (drops specks)
const PADDING = 0.04;        // crop padding, as a fraction of the larger bounding-box side
const MAX_OUT = 1024;        // px, longest side of the result
const FEATHER_PASSES = 2;    // two 3px box blurs ~ a 2px feather

let segmenterPromise = null;

function loadSegmenter(base) {
  const root = `${base}/static/vendor/mediapipe`;
  return import(`${root}/vision_bundle.mjs`).then(async ({ FilesetResolver, ImageSegmenter }) => {
    // forVisionTasks(dir) looks for vision_wasm_internal.{js,wasm} directly inside dir.
    const fileset = await FilesetResolver.forVisionTasks(`${root}/wasm`);
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${root}/selfie_multiclass_256x256.tflite`, delegate: "CPU" },
      runningMode: "IMAGE",
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });
  });
}

function getSegmenter(base) {
  if (!segmenterPromise) {
    segmenterPromise = loadSegmenter(base);
    segmenterPromise.catch(() => { segmenterPromise = null; });  // allow a retry after a failed load
  }
  return segmenterPromise;
}

// Binary mask (1 = person) from the class-index mask.
function personMask(classes) {
  const lut = new Uint8Array(256);
  for (const c of PERSON_CLASSES) lut[c] = 1;
  const m = new Uint8Array(classes.length);
  for (let i = 0; i < classes.length; i++) m[i] = lut[classes[i]];
  return m;
}

// Keeps the largest 4-connected pieces. Returns { mask, area, box } or null when nothing is left.
function keepLargest(mask, w, h) {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const pieces = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = pieces.length + 1;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    stack[sp++] = start; label[start] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = id; stack[sp++] = p + w; }
    }
    pieces.push({ id, area, x0, y0, x1, y1 });
  }
  if (!pieces.length) return null;
  const biggest = Math.max(...pieces.map((p) => p.area));
  const kept = pieces.filter((p) => p.area >= biggest * KEEP_RATIO && p.area >= MIN_PIECE * w * h);
  const keep = new Uint8Array(pieces.length + 1);
  let area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const p of kept) {
    keep[p.id] = 1; area += p.area;
    x0 = Math.min(x0, p.x0); y0 = Math.min(y0, p.y0); x1 = Math.max(x1, p.x1); y1 = Math.max(y1, p.y1);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) if (label[i] && keep[label[i]]) out[i] = 1;
  return { mask: out, area, box: { x0, y0, x1: x1 + 1, y1: y1 + 1 } };
}

// In-place 3px box blur on an 8-bit plane (horizontal then vertical).
function boxBlur(a, w, h) {
  const tmp = new Uint8Array(a.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      tmp[r + x] = ((a[r + Math.max(x - 1, 0)] + a[r + x] + a[r + Math.min(x + 1, w - 1)]) / 3) | 0;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(y - 1, 0) * w, mid = y * w, dn = Math.min(y + 1, h - 1) * w;
    for (let x = 0; x < w; x++) a[mid + x] = ((tmp[up + x] + tmp[mid + x] + tmp[dn + x]) / 3) | 0;
  }
}

function canvas2d(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d", { willReadFrequently: true })];
}

// Crops `source` to the people and applies the mask as alpha. Returns a canvas.
function compose(source, kept, mw, mh) {
  const sx = source.width / mw, sy = source.height / mh;
  const { x0, y0, x1, y1 } = kept.box;
  const pad = Math.round(PADDING * Math.max(x1 - x0, y1 - y0));
  const mx0 = Math.max(0, x0 - pad), my0 = Math.max(0, y0 - pad);
  const mx1 = Math.min(mw, x1 + pad), my1 = Math.min(mh, y1 + pad);
  const cropW = (mx1 - mx0) * sx, cropH = (my1 - my0) * sy;
  const k = Math.min(1, MAX_OUT / Math.max(cropW, cropH));
  const ow = Math.max(1, Math.round(cropW * k)), oh = Math.max(1, Math.round(cropH * k));

  // Mask -> canvas (alpha only), then smooth upscaling to the output size.
  const [mc, mg] = canvas2d(mw, mh);
  const mimg = mg.createImageData(mw, mh);
  for (let i = 0; i < kept.mask.length; i++) mimg.data[i * 4 + 3] = kept.mask[i] ? 255 : 0;
  mg.putImageData(mimg, 0, 0);
  const [ac, ag] = canvas2d(ow, oh);
  ag.imageSmoothingEnabled = true; ag.imageSmoothingQuality = "high";
  ag.drawImage(mc, mx0, my0, mx1 - mx0, my1 - my0, 0, 0, ow, oh);
  const adata = ag.getImageData(0, 0, ow, oh).data;
  const alpha = new Uint8Array(ow * oh);
  for (let i = 0; i < alpha.length; i++) alpha[i] = adata[i * 4 + 3];
  for (let i = 0; i < FEATHER_PASSES; i++) boxBlur(alpha, ow, oh);

  const [out, og] = canvas2d(ow, oh);
  og.imageSmoothingEnabled = true; og.imageSmoothingQuality = "high";
  og.drawImage(source, mx0 * sx, my0 * sy, cropW, cropH, 0, 0, ow, oh);
  const img = og.getImageData(0, 0, ow, oh);
  for (let i = 0; i < alpha.length; i++) {
    // Pull the edge in a little (hides the background fringe) while keeping it soft.
    img.data[i * 4 + 3] = Math.max(0, Math.min(255, (alpha[i] - 40) * 1.25));
  }
  og.putImageData(img, 0, 0);
  return out;
}

// Returns { canvas, coverage } with the people cut out (transparent background), or null if none were found.
export async function cutOut(source, base) {
  const segmenter = await getSegmenter(base);
  const result = segmenter.segment(source);
  let classes, w, h;
  try {
    const m = result.categoryMask;
    classes = m.getAsUint8Array().slice();  // copy: the result owns the buffer
    w = m.width; h = m.height;
  } finally {
    result.close();
  }
  const kept = keepLargest(personMask(classes), w, h);
  const coverage = kept ? kept.area / (w * h) : 0;
  if (!kept || coverage < MIN_COVERAGE) return null;
  return { canvas: compose(source, kept, w, h), coverage };
}
