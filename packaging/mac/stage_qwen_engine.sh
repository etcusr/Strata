#!/bin/bash
# Build the Qwen Metal engine and stage a verified component for a local Mac app build.
#
#   bash packaging/mac/stage_qwen_engine.sh --vision /path/to/strata-vision \
#       [--build build-metal] [--out apps/desktop/src-tauri/resources/engine-bundle] [--version 0.1.58]
#
# The package is unsigned. Release signing and feed publication remain separate steps.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BUILD="$ROOT/build-metal"
OUT="$ROOT/apps/desktop/src-tauri/resources/engine-bundle"
VERSION=0.1.58
VISION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --vision) VISION="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "an Apple Silicon Mac is required" >&2; exit 1; }
[ -f "$BUILD/CMakeCache.txt" ] || { echo "configure the Metal engine in $BUILD first" >&2; exit 1; }
[ -x "$VISION" ] || { echo "pass --vision with the Mac strata-vision binary" >&2; exit 1; }
CMAKE=${CMAKE:-cmake}
"$CMAKE" --build "$BUILD" --target strata

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/strata-qwen-engine.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/metal/kernels" "$STAGE/metal/engine-msl" "$STAGE/metal/data"
cp "$BUILD/strata" "$STAGE/strata"
cp "$VISION" "$STAGE/strata-vision"
cp "$ROOT"/metal/kernels/*.metal "$STAGE/metal/kernels/"
cp "$ROOT"/metal/src/engine/msl/*.metal "$STAGE/metal/engine-msl/"
cp "$ROOT/third_party/ggml/ggml-common.h" "$STAGE/metal/"
cp "$ROOT/data/expert-profile.bin" "$ROOT/data/draft_vocab.bin" "$STAGE/metal/data/"
BUILD_ID=$(git -C "$ROOT" rev-parse --short=12 HEAD)
python3 - "$STAGE/BUILD.json" "$VERSION" "$BUILD_ID" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[1]).write_text(json.dumps({
    "version": sys.argv[2], "source": sys.argv[3], "backend": "metal",
    "kernels": "compiled at start from metal/ beside the binary",
    "portable": True, "vision": "metal",
}, indent=2) + "\n")
PY
python3 "$ROOT/packaging/package_engine.py" --src "$STAGE" --backend metal --version "$VERSION" \
  --platform macos-arm64 --arch apple-gpu --build-id "$BUILD_ID" --include 'metal/**' --out "$OUT"
python3 "$ROOT/packaging/package_engine.py" --verify "$OUT/$VERSION-macos-arm64-metal"
echo "staged: $OUT/$VERSION-macos-arm64-metal"
