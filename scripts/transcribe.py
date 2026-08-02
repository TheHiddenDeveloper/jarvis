#!/usr/bin/env python3
"""Transcribe an audio file with faster-whisper. Usage: transcribe.py <audio> [model]"""
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

from faster_whisper import WhisperModel

MODEL = sys.argv[2] if len(sys.argv) > 2 else "base"

model = WhisperModel(MODEL, device="cpu", compute_type="int8")

segments, info = model.transcribe(
    sys.argv[1],
    language="en",
    vad_filter=True,
)
text = " ".join(s.text.strip() for s in segments)
print(text)
