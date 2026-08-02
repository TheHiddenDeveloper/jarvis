#!/usr/bin/env bash
# jarvis --voice : interactive spoken conversation loop.
#
#  1. Records a fixed window from the default PulseAudio/PipeWire mic.
#  2. Transcribes with faster-whisper.
#  3. Sends the transcript to the jarvis agent (which SPEAKS its reply via TTS).
#  4. Repeats. Ctrl+C or say "exit"/"stop jarvis" to quit.

set -euo pipefail

JARVIS_DIR="${JARVIS_DIR:-$HOME/jarvis}"
VENV_PY="$JARVIS_DIR/venv/bin/python"
TRANSCRIBE="$JARVIS_DIR/scripts/transcribe.py"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
SAY="$JARVIS_DIR/bin/say.sh"
WORK="${TMPDIR:-/tmp}/jarvis-voice"
SESSION_FILE="$WORK/session.id"

mkdir -p "$WORK"

# Mic source: override with JARVIS_MIC (e.g. "alsa_input.pci-0000_00_1f.3.analog-stereo")
MIC="${JARVIS_MIC:-default}"
WIN="${JARVIS_VOICE_WINDOW:-6}"

capture() {
  # Record a fixed window, lightly amplified (mic gain is handled via pactl).
  local out="$WORK/in.wav"
  ffmpeg -y -f pulse -i "$MIC" -t "$WIN" -af volume=8dB "$out" 2>/dev/null
  local maxv
  maxv="$(ffmpeg -i "$out" -af volumedetect -f null - 2>&1 | grep -oP 'max_volume: \K[0-9.]+' || echo -90)"
  echo "$out" "$maxv"
}

# Run the jarvis agent in ONE persistent opencode session (created on first turn,
# reused across turns until Jarvis exits). Conversation context is kept.
run_agent() {
  local prompt="$1" sid
  sid="$(cat "$SESSION_FILE" 2>/dev/null || true)"
  if [ -n "$sid" ]; then
    "$OPENCODE_BIN" run -s "$sid" --agent jarvis "$prompt" 2>/dev/null | tail -3 || true
  else
    "$OPENCODE_BIN" run --agent jarvis --title "jarvis voice" "$prompt" 2>/dev/null | tail -3 || true
    "$OPENCODE_BIN" session list 2>/dev/null | grep 'jarvis voice' | head -1 | awk '{print $1}' > "$SESSION_FILE" || true
  fi
}

echo "Jarvis voice mode. Speak within the window after the prompt. Ctrl+C or say 'exit' to quit."
echo

while true; do
  echo -n "🎤  listening (${WIN}s window)... "
  read -r file maxv < <(capture)
  if awk "BEGIN{exit !($maxv < -40)}"; then
    echo "nothing heard (${maxv}dB), retrying."
    continue
  fi
  echo "heard you (${maxv}dB), transcribing..."
  text="$("$VENV_PY" "$TRANSCRIBE" "$file" 2>/dev/null || true)"
  text="$(echo "$text" | sed 's/^ *//;s/ *$//')"
  if [ -z "$text" ]; then
    echo "(didn't catch that)"
    continue
  fi
  echo "🗣  you: $text"

  if echo "$text" | grep -qiE '^(exit|quit|goodbye|bye|stop jarvis|that.s all)$'; then
    echo "Goodbye. 👋"
    "$SAY" "Goodbye" || true
    break
  fi

  run_agent "You are in VOICE MODE (user speaks to you via microphone). Answer conversationally and briefly (1-3 short sentences, suitable for spoken reply). SPEAK your reply aloud using the jarvis-tools 'say' tool. Transcript: $text"
  echo
done
