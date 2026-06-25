#!/usr/bin/env bash
# Build the meshtasticd WASM node and stage it for the web app.
#
# The wasm C glue + WebUSB backend + emcc build now live in the firmware repo
# (src/platform/portduino/wasm/ + bin/build-portduino-wasm.sh, ARCH_PORTDUINO_WASM)
# as the single source of truth. This wrapper invokes that build and copies the
# artifacts into web/dist/ for the dev server + pages.
#
#   ./wasm/build_node.sh           # build via firmware, stage web/dist/meshnode.{mjs,wasm}
#   ./wasm/build_node.sh clean     # wipe the firmware build's object cache
#
# Prereqs: a sibling meshtastic/firmware checkout (override with FW=/path), this
# repo's emsdk (tools/setup-emsdk.sh) or any EMSDK_ENV, and firmware libdeps
# (in the firmware repo: pio run -e native-macos  — macOS — or  pio run -e native).
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FW="${FW:-$(cd "$HERE/.." && pwd)/firmware}"
[ -x "$FW/bin/build-portduino-wasm.sh" ] || {
  echo "Firmware build script not found at $FW/bin/build-portduino-wasm.sh"
  echo "Set FW=/path/to/meshtastic-firmware (a checkout with the ARCH_PORTDUINO_WASM build)."
  exit 1
}

# Let the firmware script find this repo's emsdk if no other is configured.
export EMSDK_ENV="${EMSDK_ENV:-$HERE/emsdk/emsdk_env.sh}"

FW="$FW" "$FW/bin/build-portduino-wasm.sh" "$@" || exit $?
[ "${1:-}" = "clean" ] && exit 0

mkdir -p "$HERE/web/dist"
cp "$FW/build/wasm/meshnode.mjs" "$FW/build/wasm/meshnode.wasm" "$HERE/web/dist/"
echo "staged -> web/dist/meshnode.{mjs,wasm}  (from $FW/build/wasm)"
