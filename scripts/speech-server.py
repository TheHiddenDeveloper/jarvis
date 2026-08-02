#!/usr/bin/env python3
"""Warm speech server: faster-whisper (ASR) + piper (TTS) loaded once into one
process and exposed over HTTP. The daemon POSTs wav bytes to /transcribe and
text to /speak, avoiding per-request model loads.

Endpoints:
  POST /transcribe   body: raw 16kHz mono PCM wav bytes (Content-Type: audio/wav)
                     -> {"text": "..."}
  POST /speak        body: {"text": "..."}
                     -> audio/wav bytes (base64-encoded JSON if ?json=1)
  POST /embed        body: {"text": "..."}
                     -> {"embed": [float, ...]} (fastembed, lazy-loaded)
  GET  /health       -> {"ok": true}
"""
import base64
import io
import json
import os
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

WHISPER_MODEL = os.environ.get("JARVIS_WHISPER_MODEL", "base")
PIPER_MODEL = os.environ.get(
    "JARVIS_PIPER_MODEL", os.path.expanduser("~/jarvis/models/piper/en_US-lessac-medium.onnx")
)
EMBED_MODEL = os.environ.get("JARVIS_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
PORT = int(os.environ.get("JARVIS_SPEECH_PORT", "7888"))

from faster_whisper import WhisperModel  # noqa: E402
from piper import PiperVoice  # noqa: E402

whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
voice = PiperVoice.load(PIPER_MODEL)

AUDIO_LOCK = threading.Lock()
_embed_model = None


def transcribe(wav_bytes: bytes) -> str:
    with AUDIO_LOCK:
        path = os.path.join(tempfile.gettempdir(), "jarvis-speech-in.wav")
        with open(path, "wb") as f:
            f.write(wav_bytes)
        segments, _ = whisper.transcribe(path, language="en", vad_filter=True)
        return " ".join(s.text.strip() for s in segments)


def synthesize(text: str) -> bytes:
    with AUDIO_LOCK:
        chunks = list(voice.synthesize(text))
    if not chunks:
        return b""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(chunks[0].sample_channels)
        wf.setsampwidth(chunks[0].sample_width)
        wf.setframerate(chunks[0].sample_rate)
        for c in chunks:
            wf.writeframes(c.audio_int16_bytes)
    return buf.getvalue()


def embed(text: str):
    """Semantic embedding for the reply cache (fastembed, lazy-loaded once)."""
    global _embed_model
    if _embed_model is None:
        from fastembed import TextEmbedding
        _embed_model = TextEmbedding(model_name=EMBED_MODEL)
    with AUDIO_LOCK:
        return next(iter(_embed_model.embed([text or ""]))).tolist()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep the journal quiet
        pass

    def _send(self, code, body, ctype, extra_headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b'{"ok":true}', "application/json")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        try:
            if self.path.startswith("/transcribe"):
                n = int(self.headers.get("Content-Length", 0))
                data = self.rfile.read(n)
                text = transcribe(data)
                self._send(200, json.dumps({"text": text}).encode(), "application/json")
            elif self.path.startswith("/speak"):
                n = int(self.headers.get("Content-Length", 0))
                req = json.loads(self.rfile.read(n))
                wav = synthesize(req.get("text", ""))
                as_json = self.path.startswith("/speak?json=1")
                if as_json:
                    self._send(200, json.dumps({"wav_b64": base64.b64encode(wav).decode()}).encode(),
                               "application/json")
            elif self.path.startswith("/embed"):
                n = int(self.headers.get("Content-Length", 0))
                req = json.loads(self.rfile.read(n))
                vec = embed(req.get("text", ""))
                self._send(200, json.dumps({"embed": vec}).encode(), "application/json")
            else:
                self._send(404, b"not found", "text/plain")
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")


def main():
    print(f"speech-server ready on :{PORT} (whisper={WHISPER_MODEL}, piper loaded)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
