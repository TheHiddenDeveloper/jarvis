# Decisions

- [2026-08-02] **Build Jarvis as opencode + MCP layers** rather than a single script: opencode (brain) + jarvis agent + local MCP servers (hands).
- [2026-08-02] **Wayland toolchain chosen**: wtype/grim/slurp/wl-clipboard instead of xdotool (incompatible with Wayland).
- [2026-08-02] **Secrets migrated** from opencode.json plaintext to ~/.config/opencode/secrets/ (chmod 600), referenced via {file:} substitution. User should rotate the old GitHub token.
- [2026-08-02] **MCP packages installed locally** under ~/jarvis/mcp/ (not global) so node upgrades via fnm don't break them.

- [2026-08-02] Voice stack (2026-08-02): faster-whisper "base" model in ~/jarvis/venv (HF_HUB_DISABLE_XET=1 needed — xet downloader hangs). TTS via espeak-ng. `jarvis --voice` = fixed-window mic capture → whisper → agent speaks via say tool.

- [2026-08-02] TTS upgraded to piper (neural, en_US-lessac-medium, ~63MB model in ~/jarvis/models/piper). Helper ~/jarvis/bin/say.sh (piper → paplay, falls back to espeak-ng). MCP 'say' tool now defaults to piper; JARVIS_TTS=edge still supported. Much smoother than espeak-ng.

- [2026-08-02] Voice loop now keeps ONE persistent opencode session across turns: stores session id in /tmp/jarvis-voice/session.id, reuses via `opencode run -s <id> --agent jarvis`. Verified continuity (agent remembered "secret number 42" across turns). Each turn still spawns a process but conversation context persists until Jarvis exits.

## 2026-08-02 — Phase 3 remote UI (widget + PWA) complete
- Both daemon input paths verified end-to-end: text -> persistent session -> piper audio; and base64 WAV -> whisper transcribe -> session -> piper audio. Reply WAV is valid (4.3s).
- Root cause of wrapped JSON in transcript: extractReply fell back to the raw line when the agent emitted `{"reply":...}` on its own line and JSON.parse(slice(first{,last})) broke. Fix: per-line JSON parse first, then recursive unwrapReply (up to 3 nested levels). All replies now clean text.
- PWA verified in Brave (Playwright): login persists token in localStorage, text ask returns clean reply, persistent session recalled "purple" across turns, zero console errors (added <link rel="icon" href="/icon.svg"> to kill favicon 404).
- Widget = Tauri 2 desktop shell (frameless, always-on-top, 380x620) loading the daemon URL as its frontend (same-origin fetch works automatically, csp: null). Built at ~/jarvis/widget (cargo 1.93, webkit2gtk-4.1, gtk3, libsoup3).
- Icons rasterized from public/icon.svg via rsvg-convert into widget/icons/{32x32,128x128,128x128@2x,icon}.png. bundle.active=false (Linux dev needs PNGs only).
- systemd GUI autostart FAILS: service context lacks Wayland/display env so the WebKit window won't start. Use KDE ~/.config/autostart/*.desktop instead (jarvis-widget.desktop -> ~/jarvis/bin/widget.sh).
- Launcher ~/jarvis/bin/widget.sh prefers target/release/jarvis-widget, falls back to debug.

## 2026-08-02 — WebKitGTK mic + token fixes (Phase 3 follow-up)
- Root cause of "Mic error: NotAllowedError" in the Tauri widget: WebKitGTK/Tauri has NO permission-request handler, so getUserMedia is auto-denied on Linux. Fix: daemon owns mic capture. Added POST /api/mic/start + /api/mic/stop (ffmpeg -f pulse -i default -af volume=8dB -ar 16000 -ac 1 -> host-mic.wav, SIGTERM on stop, 60s auto-stop). app.js uses daemon-side capture when IS_LOCAL (hostname 127.0.0.1/localhost), else on-device MediaRecorder (phone path).
- Added GET /api/token: loopback-only bootstrap (checks req.socket.remoteAddress via isLoopback) so the widget/local browser auto-provisions the token and never shows the modal. Non-loopback gets 403 (remote phone must type/be given the token).
- Verified real-mic path end-to-end in Brave: spoke "This is a real speech test." -> transcribed -> replied -> idle. ffmpeg recorder confirmed spawning.
- Service worker was cache-first with fixed name jarvis-v1 -> served STALE app.js (that's why the widget showed the old getUserMedia mic error). Fixed: sw.js now network-first with cache fallback, cache name bumped to jarvis-v2. Also nuke old caches/unregister via evaluate when testing.
- pkill -f 'widget/target/release/jarvis-widget' matches the shell's own argv -> kills the shell. Use the [j]arvis-widget bracket trick.
- NOTE for phone path: getUserMedia requires a SECURE context (HTTPS). Plain http://<tailscale-ip>:7878 will fail on a phone -> need tailscale cert (HTTPS) before phone voice works. Text path works over HTTP.

## 2026-08-02 — Widget mic error was STALE CACHED app.js (final resolution)
- The user STILL saw "Mic error: NotAllowedError" after the daemon-mic fix. Root cause: the widget's WebKitGTK kept serving the OLD cache-first-SW cached app.js (getUserMedia path). The daemon served the new code fine; the widget did not.
- Fix chain: (1) sw.js now network-first w/ cache fallback + v2. (2) app.js unregisters the service worker on loopback (IS_LOCAL) so it can never serve stale assets again. (3) Widget loads a versioned URL (tauri.conf devUrl/frontendDist = http://127.0.0.1:7878/?v=3) so the top-level document always cache-misses -> fresh index.html -> new SW installs -> next/current load is fresh.
- Verified via daemon request log (added [req] debug middleware, JARVIS_DEBUG=1): widget fetched /?v=3 + /app.js fresh. End-to-end re-verified in Playwright: auto-token (no modal), mic -> /api/mic/start (ffmpeg spawned), real speech -> transcribed -> replied.
- Synthetic clicks (ydotool) DON'T register on the WebKitGTK widget window; real user clicks do (that's how the error surfaced). To find widget geometry on KDE Wayland: `kdotool search --class jarvis` -> `kdotool getwindowgeometry "{uuid}"`.

- [2026-08-02] [2026-08-02] Made the desktop widget movable. Root cause: frameless Tauri window (decorations:false) had no drag region. Fix: (1) added ~/jarvis/widget/capabilities/default.json granting core:window:allow-start-dragging with remote urls ["http://127.0.0.1:7878/*"] (required because the widget loads a remote HTTP origin — without the remote block the startDragging IPC is denied); (2) added data-tauri-drag-region to <header> + children (.brand, .logo, h1, .status) in server/public/index.html (the attr does NOT propagate to children); (3) cursor:grab on header in style.css. Rebuilt with cargo build --release. Verified: daemon serves updated HTML, strings in the binary contain allow-start-dragging + the remote URL, widget window up (class jarvis-widget, 380x620). Drag still needs a real-mouse test — synthetic ydotool clicks don't register on WebKitGTK.

- [2026-08-02] - [2026-08-02] Obsidian vault (~/Ideaverse) is now the CANONICAL long-term brain; ~/jarvis/memory/ is the fast-access layer. Added jarvis-tools MCP tools: vault_read, vault_search, vault_write, vault_context (runs vault's context-bridge.sh), vault_log (runs vault's execution-logger.sh, Post-Flight). Reuses the vault's own scripts/conventions instead of reinventing. Store facts once — in the vault, referenced from memory/.

- [2026-08-02] - [2026-08-02] Semantic recall added to the Ideaverse brain: scripts/vault-embed.py (fastembed ONNX CPU, BAAI/bge-small-en-v1.5, 384-dim) chunks notes by section, incremental by mtime, index in state/vault-index.json. MCP tool vault_search_semantic added. 120 notes / 785 chunks indexed. Auto-builds on first use.
