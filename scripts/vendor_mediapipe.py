#!/usr/bin/env python3
"""Vendors the pinned MediaPipe tasks-vision 1.2.3 runtime and the selfie_multiclass model
into app/static/vendor/mediapipe/. Fails closed: any hash mismatch aborts before anything is installed.

Downloads and the extracted tarball live in a fresh temporary directory; the tarball is verified
against the npm sha512 integrity, then each extracted file against its pinned sha256.
Run via scripts/vendor-mediapipe.sh.
"""
import base64
import hashlib
import io
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "1.2.3"
TARBALL_URL = "https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.2.3.tgz"
INTEGRITY = ("sha512-sxJyfhbN+EamexhaaCmUlw7v8vWWMum7VDsORe6d4c8Dk/xlI4qiIgoSw9cE9hpvYhVRRVLIA8y605FbqWkNeQ==")
# path inside the tarball (without the leading package/) -> sha256
FILES = {
    "vision_bundle.mjs": "fb0c02c296f44ce0cc324ba16bd646d8773eb4a7847db4019cc4d0430db7a9b5",
    "wasm/vision_wasm_internal.js": "2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309",
    "wasm/vision_wasm_internal.wasm": "225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf",
}
LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0.txt"
LICENSE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/image_segmenter/"
             "selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite")
MODEL_NAME = "selfie_multiclass_256x256.tflite"
MODEL_SHA256 = "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0"
MODEL_SIZE = 16371837

MODEL_CARD = """\
# Model card note

`selfie_multiclass_256x256.tflite` is Google's MediaPipe multi-class selfie segmentation model
(float32, version 1), used for cutting people out of uploaded photos. Classes: 0 background,
1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 others (accessories).

Model card (MediaPipe Selfie Segmentation, the model family this one belongs to):
https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf
This PDF is the general selfie-segmentation card; a card specific to the multi-class variant was not
verified. Documentation: https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter

Source: {url}
sha256: {sha}

The model is run in the browser only (never on the server). The runtime in this directory is
@mediapipe/tasks-vision {version}, Apache-2.0 (see LICENSE). Re-create with scripts/vendor-mediapipe.sh.
"""


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def die(msg):
    sys.exit("vendor-mediapipe: " + msg)


def main():
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "app/static/vendor/mediapipe"

    tgz = fetch(TARBALL_URL)
    algo, _, b64 = INTEGRITY.partition("-")
    if algo != "sha512" or base64.b64encode(hashlib.sha512(tgz).digest()).decode() != b64:
        die("tarball integrity mismatch")

    staged = {}
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tf:
        for rel, want in FILES.items():
            member = tf.getmember("package/" + rel)
            if not member.isfile():
                die(rel + " is not a regular file")
            data = tf.extractfile(member).read()
            if hashlib.sha256(data).hexdigest() != want:
                die("sha256 mismatch for " + rel)
            staged[rel] = data

    # The npm tarball ships no LICENSE file (package.json declares Apache-2.0): use the canonical text.
    lic = fetch(LICENSE_URL)
    if hashlib.sha256(lic).hexdigest() != LICENSE_SHA256:
        die("Apache-2.0 license text sha256 mismatch")
    staged["LICENSE"] = lic

    model = fetch(MODEL_URL)
    if len(model) != MODEL_SIZE or hashlib.sha256(model).hexdigest() != MODEL_SHA256:
        die("model sha256/size mismatch")
    staged[MODEL_NAME] = model
    staged["MODEL_CARD.md"] = MODEL_CARD.format(url=MODEL_URL, sha=MODEL_SHA256, version=VERSION).encode()

    with tempfile.TemporaryDirectory() as tmp:
        for rel, data in staged.items():
            p = Path(tmp) / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(tmp, dest)
    print("mediapipe tasks-vision %s + %s installed in %s" % (VERSION, MODEL_NAME, dest))


if __name__ == "__main__":
    main()
