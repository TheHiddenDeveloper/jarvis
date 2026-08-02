#!/usr/bin/env bash
# Launch the Jarvis desktop widget (Tauri). Prefers release binary.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"           # ~/jarvis
BIN="$DIR/widget/target/release/jarvis-widget"
[ -x "$BIN" ] || BIN="$DIR/widget/target/debug/jarvis-widget"
exec "$BIN"
