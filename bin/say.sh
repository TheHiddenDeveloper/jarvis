#!/usr/bin/env bash
# Speak text aloud via piper (neural TTS). Text from "$1" or stdin.
# Falls back to espeak-ng if piper is unavailable.
set -euo pipefail

MODEL="${JARVIS_PIPER_MODEL:-$HOME/jarvis/models/piper/en_US-lessac-medium.onnx}"
PIPER="${JARVIS_PIPER:-$HOME/jarvis/venv/bin/piper}"
SPEED="${JARVIS_PIPER_SPEED:-1.0}"
RATE=22050

text="${1:-}"
if [ -z "$text" ]; then
  text="$(cat 2>/dev/null || true)"
fi
[ -n "$text" ] || exit 0

if command -v paplay >/dev/null 2>&1 && [ -f "$MODEL" ]; then
  printf '%s\n' "$text" | timeout 20 "$PIPER" --model "$MODEL" --length-scale "$SPEED" --output-raw 2>/dev/null \
    | timeout 20 paplay --raw --format=s16le --rate="$RATE" --channels=1 2>/dev/null || \
    printf '%s\n' "$text" | timeout 20 espeak-ng 2>/dev/null || true
else
  printf '%s\n' "$text" | timeout 20 espeak-ng 2>/dev/null || true
fi
