# Jarvis Platform Layout

Jarvis shares **one runtime** across Windows and Linux; only the *launch /
deploy* tooling is per-platform. This keeps fixes (bug fixes, new tools) in a
single copy while letting each OS manage its own process lifecycle.

## Rule

- **Shared runtime** (platform-agnostic) lives at the repo root / `server/` /
  `scripts/`:
  - `server/daemon.js` — the Express daemon (web UI + API + warm servers).
    Must stay `process.platform`-portable; isolate OS quirks in named helpers
    (e.g. `OPENCODE_SPAWN`), never sprinkle inline `if (win32)`.
  - `server/public/` — PWA front end (cross-platform).
  - `server/opencode-agents/` — agent templates (cross-platform).
  - `scripts/*.py` — `speech-server.py`, `transcribe.py`, `vault-embed.py`,
    `jarvis-kg.py` (python helpers branch on `os.name` internally).
- **Per-platform deploy** goes in `deploy/<platform>/`:
  - `deploy/windows/` — scheduled-task installer, service management,
    bootstrap, the `start-jarvis.cmd` launcher, and (archived) NSSM scripts.
  - `deploy/linux/` — systemd unit example, dependency setup script.

**If something is OS-specific, it belongs under `deploy/<platform>/` — never
in `server/` or `scripts/`.** Follow the existing filename convention
(`.cmd`/`.ps1` = Windows, `.sh`/`.service.example` = Linux).

## Windows (`deploy/windows/`)

| File | Purpose |
|------|---------|
| `start-jarvis.cmd` | Launcher used by the scheduled task (sets OPENCODE_BIN/PATH, logs) |
| `install-task.ps1` | Registers the `Jarvis` scheduled task (logon + boot, restart 5x) |
| `service.ps1` | Manual `status/start/stop/restart/logs` helper |
| `bootstrap-windows.ps1` | One-time machine setup |
| `bin/nssm.exe` | NSSM binary (kept for the legacy service model) |
| `archive/` | Superseded scripts (NSSM service install/uninstall) |

The scheduled task is the **current** persistence model on Windows (a SYSTEM
service is not viable because the daemon needs the interactive user's
`HOME`/profile and desktop session).

## Linux / Manjaro (`deploy/linux/`)

- `jarvis-daemon.service.example` — systemd user unit for `daemon.js`.
- `setup-deps.sh` — installs the Python/Node/system dependencies.

See `deploy/linux/README.md` for the Manjaro install + service steps.
