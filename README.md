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

Requires Python 3.8+. Shake works with device motion on phones (iOS shows an "Enable shake" button) and with drag/mouse movement elsewhere. Note that device motion and service workers need HTTPS (or `localhost`).

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
- `POST /api/globes?config=<json>` with the raw image as body. The server checks the declared type, the file's magic bytes, the size and the rate limit, validates settings against a whitelist, and stores `<id>.<ext>` + `<id>.json` in `DATA_DIR`.
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
