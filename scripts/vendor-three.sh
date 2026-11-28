#!/bin/sh
# Downloads the pinned three.js build (and its MIT license) into app/static/vendor/.
# Also fetches RoomEnvironment and rewrites its bare 'three' import to the local build.
set -eu
VERSION=0.160.0
REV=r160
DEST="$(dirname "$0")/../app/static/vendor"
mkdir -p "$DEST"
curl -fsSL "https://cdn.jsdelivr.net/npm/three@$VERSION/build/three.module.min.js" -o "$DEST/three.module.min.js"
curl -fsSL "https://raw.githubusercontent.com/mrdoob/three.js/$REV/LICENSE" -o "$DEST/THREE_LICENSE"
curl -fsSL "https://raw.githubusercontent.com/mrdoob/three.js/$REV/examples/jsm/environments/RoomEnvironment.js" \
  | sed "s#from 'three';#from './three.module.min.js';#" > "$DEST/RoomEnvironment.js"
echo "three.js $VERSION installed in $DEST"
