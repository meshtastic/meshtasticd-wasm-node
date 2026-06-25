#!/usr/bin/env bash
# Install + activate the Emscripten SDK for the wasm build (Checkpoint A onward).
# Idempotent: re-running just refreshes activation. Source the env after:
#   source ./emsdk/emsdk_env.sh
set -euo pipefail

EMSDK_VERSION="${EMSDK_VERSION:-latest}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="$HERE/emsdk"

if [ ! -d "$EMSDK_DIR" ]; then
  echo "Cloning emsdk into $EMSDK_DIR"
  git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi

cd "$EMSDK_DIR"
git pull --ff-only || true
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"

echo
echo "emsdk ready. Activate it in your shell with:"
echo "    source \"$EMSDK_DIR/emsdk_env.sh\""
echo "Then: emcc --version"
