#!/usr/bin/env bash
# Build the meshtasticd WASM node and stage it for the web app.
#
# The wasm C glue + WebUSB backend + the build itself now live in the firmware
# repo as a first-class PlatformIO env: `pio run -e native-wasm` (board `wasm`, the
# meshtastic/platform-wasm platform, ARCH_PORTDUINO_WASM). This wrapper just runs
# that build and copies the artifacts into web/dist/ for the dev server + pages.
#
#   ./wasm/build_node.sh           # build via firmware, stage web/dist/meshnode.{mjs,wasm}
#   ./wasm/build_node.sh clean     # wipe the firmware wasm build dir
#
# Prereqs: a sibling meshtastic/firmware checkout (override with FW=/path),
# PlatformIO on PATH, and this repo's emsdk (tools/setup-emsdk.sh) or any EMSDK on
# PATH so the platform-wasm builder can find emcc.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FW="${FW:-$(cd "$HERE/.." && pwd)/firmware}"
[ -f "$FW/platformio.ini" ] || {
  echo "Firmware checkout not found at $FW (no platformio.ini)."
  echo "Set FW=/path/to/meshtastic-firmware (a checkout with the [env:native-wasm] target)."
  exit 1
}

# Put this repo's emsdk on PATH if emcc isn't already available.
if ! command -v emcc >/dev/null 2>&1 && [ -f "$HERE/emsdk/emsdk_env.sh" ]; then
  # shellcheck disable=SC1091
  source "$HERE/emsdk/emsdk_env.sh" >/dev/null 2>&1
fi

OUT="$FW/.pio/build/native-wasm"

if [ "${1:-}" = "clean" ]; then
  ( cd "$FW" && pio run -e native-wasm -t clean ) || exit $?
  exit 0
fi

( cd "$FW" && pio run -e native-wasm ) || exit $?

[ -s "$OUT/meshnode.mjs" ] && [ -s "$OUT/meshnode.wasm" ] || {
  echo "Expected artifacts missing under $OUT"
  exit 1
}

mkdir -p "$HERE/web/dist"
cp "$OUT/meshnode.mjs" "$OUT/meshnode.wasm" "$HERE/web/dist/"
echo "staged -> web/dist/meshnode.{mjs,wasm}  (from $OUT)"
