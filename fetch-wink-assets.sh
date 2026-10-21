#!/bin/sh
# Fetch the face-landmark model and runtime that Wink page turning reads a wink
# with, into lib/mediapipe/.
#
# They are kept out of the repository because they are 17 MB of somebody else's
# build output, and out of build.py because nothing else in this build touches
# the network. So they are fetched once, by hand, and verified against the
# checksums below:
#
#   sh fetch-wink-assets.sh
#
# Everything that reads them treats them as optional. Without them the build
# still builds and the app still runs; the Wink tool says the model is missing
# and the rest of Podium does not care.
#
# CURL_OPTS is passed through to curl, for a network that needs persuading:
#
#   CURL_OPTS=--ssl-no-revoke sh fetch-wink-assets.sh
#
# The versions are pinned. Moving either of them means new checksums here, and
# measuring the wink limits again: a new model is a new set of scores.

set -eu

VISION_VERSION=1.1.1
VISION_TARBALL="https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-${VISION_VERSION}.tgz"
# The model garden's pinned revision 1 of the float16 face landmarker. The task
# bundle carries the detector, the mesh and the blendshape head together.
MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"

# sha256. The tarball's is checked before anything is unpacked from it.
TARBALL_SUM=fbbea455a8b50c31c39092027b3548336de198bfcdbaf75cc08245e773011b8f
MODEL_SUM=64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff
BUNDLE_SUM=a84921e02321e582484c1f8126d344b5f33b791fa09c640a52e20ee8632068f1
WASM_JS_SUM=6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8
WASM_SUM=0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd

here=$(cd "$(dirname "$0")" && pwd)
dest="$here/lib/mediapipe"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

verify() { # file expected-sum
  got=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$got" = "$2" ] && return 0
  echo "Error: $1" >&2
  echo "  expected sha256 $2" >&2
  echo "  got             $got" >&2
  exit 1
}

get() { # url file
  echo "-- fetching $(basename "$2")"
  # shellcheck disable=SC2086
  curl -fsSL ${CURL_OPTS:-} -o "$2" "$1"
}

get "$VISION_TARBALL" "$work/tasks-vision.tgz"
verify "$work/tasks-vision.tgz" "$TARBALL_SUM"
get "$MODEL_URL" "$work/face_landmarker.task"
verify "$work/face_landmarker.task" "$MODEL_SUM"

# Only the SIMD runtime is kept. The package also carries a no-SIMD fallback of
# the same size again, for browsers from before 2021; the Wink tool asks the
# browser for SIMD up front and says so plainly where it is missing, which is
# better than shipping 13 MB more against a browser this app has other reasons
# not to run on.
tar -xzf "$work/tasks-vision.tgz" -C "$work" \
  package/vision_bundle.mjs \
  package/wasm/vision_wasm_internal.js \
  package/wasm/vision_wasm_internal.wasm

verify "$work/package/vision_bundle.mjs" "$BUNDLE_SUM"
verify "$work/package/wasm/vision_wasm_internal.js" "$WASM_JS_SUM"
verify "$work/package/wasm/vision_wasm_internal.wasm" "$WASM_SUM"

mkdir -p "$dest/wasm"
cp "$work/package/vision_bundle.mjs" "$dest/vision_bundle.mjs"
cp "$work/package/wasm/vision_wasm_internal.js" "$dest/wasm/vision_wasm_internal.js"
cp "$work/package/wasm/vision_wasm_internal.wasm" "$dest/wasm/vision_wasm_internal.wasm"
cp "$work/face_landmarker.task" "$dest/face_landmarker.task"

cat > "$dest/PROVENANCE.txt" <<PROVENANCE
MediaPipe Face Landmarker, as fetched by fetch-wink-assets.sh. Do not edit by
hand -- run the script again instead.

Runtime: @mediapipe/tasks-vision ${VISION_VERSION}, Apache-2.0, from
  ${VISION_TARBALL}
  vision_bundle.mjs               sha256 ${BUNDLE_SUM}
  wasm/vision_wasm_internal.js    sha256 ${WASM_JS_SUM}
  wasm/vision_wasm_internal.wasm  sha256 ${WASM_SUM}

Model: face_landmarker, float16, revision 1, Apache-2.0, from
  ${MODEL_URL}
  face_landmarker.task            sha256 ${MODEL_SUM}

The licence is in licenses/mediapipe.txt. The model runs in the browser and
nothing it sees leaves the device: there is no MediaPipe service behind it.
PROVENANCE

echo "-- lib/mediapipe is ready ($(du -sh "$dest" | cut -f1))"
