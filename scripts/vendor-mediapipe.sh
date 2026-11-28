#!/bin/sh
# Vendors the pinned MediaPipe tasks-vision runtime + selfie segmentation model into
# app/static/vendor/mediapipe/ (integrity and per-file sha256 are verified; fails closed).
set -eu
exec python3 -I "$(dirname "$0")/vendor_mediapipe.py" "$@"
