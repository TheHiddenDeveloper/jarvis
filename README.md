# Jarvis — Personal AI Assistant

A local, self-hosted assistant for the Hidden Developer's machine. Built on opencode (brain) + MCP servers (hands), with a web PWA, a desktop widget (Tauri), and voice input/output.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Front doors:  jarvis (CLI) · cron · web UI (PWA) ·     │
│                desktop widget (Tauri) · voice loop      │
├─────────────────────────────────────────────────────────┤
│  Brain: opencode → "jarvis" agent                        │
│         · AGENTS.md machine profile                      │
│         · memory/ persistent knowledge                   │
│         · agents/jarvis.md operating rules + perms       │
│         · agents/jarvis-voice.md lean fast-path agent    │
├─────────────────────────────────────────────────────────┤
│  Hands (MCP servers):                                   │
│   · filesystem   — file read/write/search               │
│   · playwright   — browser automation                   │
│   · jarvis-tools — desktop control, OCR, clipboard,     │
│                    notifications, TTS, memory            │
├─────────────────────────────────────────────────────────┤
│  Daemon: express server on :7878                         │
│   · serves the PWA (server/public/)                      │
│   · REST API: text ask, mic capture, loopback token      │
│   · speaks replies via piper (neural TTS)                │
├─────────────────────────────────────────────────────────┤
│  Warm servers (spawned + kept alive by the daemon):     │
│   · scripts/speech-server.py (:7888)                     │
│     whisper ASR + piper TTS loaded ONCE in one process  │
│   · opencode serve (:4096, password-gated)               │
│     hot opencode agent — no per-request process boot    │
└─────────────────────────────────────────────────────────┘
```

## Usage

```sh
jarvis "organize my Downloads folder"     # one-shot task
jarvis --interactive                      # chat session
jarvis --voice                            # spoken conversation (mic → Whisper → piper reply)
```

Or open the web UI / desktop widget: daemon serves `http://localhost:7878`.

## Layout

| Path | Purpose |
|---|---|
| `AGENTS.md` | Machine profile + operating rules |
| `bin/jarvis` | CLI front door |
| `bin/voice-loop.sh` | Voice conversation loop (persistent session) |
| `bin/say.sh` | TTS: piper → paplay, fallback espeak-ng |
| `bin/widget.sh` | Launches the Tauri desktop widget |
| `memory/` | Long-term memory (see `memory/README.md`) |
| `mcp/jarvis-tools/` | Custom desktop-control MCP server |
| `mcp/filesystem/` | Official filesystem MCP |
| `mcp/playwright/` | Browser automation MCP |
| `server/` | Node/express daemon + PWA (`server/public/`) |
| `deploy/` | Per-platform launch tooling. **Convention:** shared runtime stays in `server/` + `scripts/`; anything OS-specific lives in `deploy/windows/` or `deploy/linux/` (see `deploy/README.md`) |
| `scripts/transcribe.py` | faster-whisper transcription (one-shot) |
| `scripts/speech-server.py` | Warm ASR+TTS server: whisper + piper loaded once, HTTP (`:7888`) |
| `widget/` | Tauri 2 desktop widget (frameless, always-on-top) |

## Setup on another PC

Requires: Manjaro/Arch (or similar), Wayland/KDE, Node 20+, Rust/cargo, Python venv.

### 1. System deps

```sh
bash deploy/linux/setup-deps.sh   # wtype grim slurp wl-clipboard ydotool tesseract, mic gain, input group
sudo pacman -S --needed ffmpeg espeak-ng
# Tauri widget: cargo, webkit2gtk-4.1, gtk3, libsoup3, librsvg
```

### 2. Voice + memory env (Python venv)

```sh
python -m venv ~/jarvis/venv
~/jarvis/venv/bin/pip install faster-whisper piper-tts fastembed
# piper model → ~/jarvis/models/piper/ (en_US-lessac-medium.onnx, ~63MB)
export HF_HUB_DISABLE_XET=1     # required — the xet downloader hangs otherwise
```

`fastembed` powers semantic memory search (`vault_search_semantic`): local ONNX embeddings
(bge-small-en-v1.5, ~130MB download on first use) over the Obsidian vault at `~/Ideaverse`.
Index is incremental (by file mtime) and lives in `state/vault-index.json` (gitignored).

### 3. Daemon + PWA

```sh
cd ~/jarvis/server && npm install
cp ~/jarvis/.env.template ~/jarvis/.env   # add NTFY_TOPIC for phone push
node daemon.js                             # → http://localhost:7878
```

### 4. opencode wiring

- Install opencode; define the `jarvis` agent (primary) — rules + permission table live in the repo docs.
- In `~/.config/opencode/opencode.json`, register the three MCP servers (jarvis-tools, filesystem, playwright). Keys go in `~/.config/opencode/secrets/` (chmod 600), referenced via `{file:...}`.

### 5. Systemd daemon (user service)

```ini
# ~/.config/systemd/user/jarvis-daemon.service
ExecStart=<node> <your-home>/jarvis/server/daemon.js
WorkingDirectory=<your-home>/jarvis/server
```
```sh
systemctl --user daemon-reload && systemctl --user enable --now jarvis-daemon.service
```

### 6. Widget autostart (KDE only)

```sh
cd ~/jarvis/widget && cargo build --release
# ~/.config/autostart/jarvis-widget.desktop → Exec=<home>/jarvis/bin/widget.sh
```

**Note:** the widget must autostart via KDE `~/.config/autostart/`, NOT systemd — the service context lacks Wayland/display env and the WebKit window won't start.

## Operational notes (hard-won)

- The daemon runs opencode via `spawn` with `stdio:['ignore','pipe','pipe']` — **never `exec`** (hangs at init). Sessions are cwd-bound; the agent prompt must forbid tools (else it hangs detached).
- **Latency is kept low by warm servers.** `opencode run -s <id>` hangs (60s+) when the daemon cwd doesn't match the session's `directory` — so the daemon talks to one hot `opencode serve` process over HTTP instead (`POST /session/{id}/message`, basic-auth from `state/opencode-server.password`), and to the warm speech server for ASR/TTS. Cold spawn is only a fallback. Measured end-to-end: text ~2.4s, voice ~3.7s (conversational).
- `opencode run --attach` still boots the full client (~11s) — not a latency win; the HTTP API is.
- Mic capture is **daemon-side** on the widget: WebKitGTK has no permission-request handler, so `getUserMedia` is always denied on Linux. Use `POST /api/mic/start` + `/api/mic/stop` (ffmpeg pulse capture, 60s auto-stop).
- **Voice replies are routed.** Pattern classifier sends tasks (apps/files/web/system) to the full `jarvis` agent; casual chit-chat goes to the lean `jarvis-voice` agent (own warm session, tiny prompt, no tools) for faster replies. If `jarvis-voice` decides a request needs real action it replies `TASK` and the daemon escalates to `jarvis`. Both sessions are warmed (message + revert) at boot so MCP/models are pre-loaded. The client plays a reflex chime (`/chime.wav`, generated at boot) the instant the user submits, so there is no dead silence while the reply generates.
- `GET /api/token` returns the auth token **only on loopback** — widget/local browser auto-provisions; a remote phone gets 403 and must be given the token.
- Service worker is **network-first** (jarvis-v2). A cache-first SW served stale JS and broke the widget; the SW self-unregisters on loopback and the widget pins `?v=3`.
- Phone voice needs HTTPS (tailscale cert) — `getUserMedia` requires a secure context. Text works over HTTP.

## Security

- Secrets never committed: `state/` (server token, session ids, mic captures), `.env`, `*.env` all gitignored. See `.env.template`.
- Token bootstrap is loopback-only; the API key lives in env or `state/server.token`.
- Rotate any token that has ever leaked (e.g. old GitHub PAT).

## Status

- ✅ CLI, persistent sessions, memory, browser automation, desktop control
- ✅ TTS (piper), voice loop, daemon PWA + REST API, loopback token
- ✅ Tauri desktop widget, KDE autostart, daemon-side mic (verified real speech → reply)
- ⬜ Phone PWA over HTTPS (secure context), scheduling/cron phase
