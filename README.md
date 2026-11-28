# Snowglobe

A tiny web app: upload a photo, put it inside a glass snow globe, shake it, and share a read-only link.

- Frontend: vanilla JS + [three.js](https://threejs.org) (vendored locally, no CDN), installable PWA
- Backend: Python 3 standard library only (`app/server.py`), no `pip install`
- UI languages: Greek (default) and English, easy to extend (`app/static/i18n.js`)

## Quick start

```sh
./scripts/vendor-three.sh        # only needed if app/static/vendor/three.module.min.js is missing
python3 app/server.py
# open http://localhost:8000
```

Requires Python 3.8+. Shake works with device motion on phones (iOS shows an "Enable shake" button) and with a finger/mouse stirring the snow where you touch elsewhere. Two fingers (or right-button / shift + drag on a desktop) rotate the globe. Note that device motion and service workers need HTTPS (or `localhost`).

## Configuration (environment variables)

| Variable        | Default  | Meaning                                                        |
|-----------------|----------|----------------------------------------------------------------|
| `PORT`          | `8000`   | Listen port                                                    |
| `HOST`          | `0.0.0.0`| Bind address                                                   |
| `DATA_DIR`      | `./data` | Where photos and settings JSON are stored                      |
| `MAX_UPLOAD_MB` | `5`      | Maximum accepted photo size                                    |
| `BASE_PATH`     | empty    | URL prefix behind a reverse proxy, e.g. `/snow`                |
| `RATE_LIMIT`    | `10`     | Max uploads per IP per window                                  |
| `RATE_WINDOW`   | `60`     | Rate-limit window in seconds                                   |
| `MAX_GLOBES`    | `10000`  | Max stored globes (protects disk)                              |
| `TRUST_PROXY`   | unset    | Set to `1` to take the client IP from `X-Forwarded-For`        |
| `DEFAULT_LANG`  | `el`     | Default UI language (`el`, `en`, or any you add)               |

## Reverse proxy

Strip nothing: forward `/snow/...` as-is and set `BASE_PATH=/snow`. Enable `TRUST_PROXY=1` only if the proxy sets `X-Forwarded-For` itself, otherwise the rate limit can be bypassed. The app has no authentication: anyone who can reach it can upload (within the limits) and anyone with a link can view.

## Docker

```sh
docker build -t snowglobe .
docker run -p 8000:8000 -v snowglobe-data:/data snowglobe
```

## How it works

- The browser resizes/compresses the photo (max 1280px JPEG) before upload.
- **Figures** (`cutout` shape): after choosing a photo, people are cut out in the browser with MediaPipe selfie segmentation (main thread, no worker) and shown as a standing figure without background. Only the cut-out image (WebP with alpha, PNG where the browser cannot encode WebP) is uploaded; the viewer runs no ML. If fewer than 3% of the picture is a person the app says "no people found" and keeps the plaque. The runtime (~15 MB wasm) and model (~16 MB) are loaded lazily on first use, are not precached by the service worker, and are served with `Cache-Control: immutable`.
- `POST /api/globes?config=<json>` with the raw image as body. The server checks the declared type, the file's magic bytes, the size and the rate limit, validates settings against a whitelist, and stores `<id>.<ext>` + `<id>.json` in `DATA_DIR`. For `shape=cutout` the PNG/WebP header must declare an alpha channel.
- The id is `secrets.token_urlsafe(12)`; the share link is `/g/<id>` (read-only viewer).
- Stored files are never executed; photos are served with a fixed image content type and `nosniff`.

## Adding a language

Copy a block in `app/static/i18n.js`, translate the values and give it a new key (e.g. `de`). It shows up in the selector automatically.

## Tests

```sh
python3 -m unittest discover -s tests -v
```

## Third-party

three.js is MIT licensed; its license is kept next to the vendored file in `app/static/vendor/`.

`@mediapipe/tasks-vision` 1.2.3 (Apache-2.0) and the `selfie_multiclass_256x256` model live in `app/static/vendor/mediapipe/` (with `LICENSE` and `MODEL_CARD.md`). They are pinned and re-creatable with `./scripts/vendor-mediapipe.sh`, which verifies the npm sha512 integrity of the tarball and the sha256 of every file, and fails closed. The CSP only gains `'wasm-unsafe-eval'` in `script-src`. The bundle contains an unused telemetry URL (`odml.pa.googleapis.com`); `connect-src 'self'` keeps it from being contacted.
