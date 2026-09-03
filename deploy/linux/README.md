# Jarvis on Linux / Manjaro

Linux shares the same runtime (`server/daemon.js`, `scripts/*.py`) as Windows —
only the launch / service management differs. This folder holds the Linux bits.

## Files

| File | Purpose |
|------|---------|
| `setup-deps.sh` | Installs Wayland automation tools (wtype, grim, slurp, wl-clipboard, ydotool, tesseract), mic gain, input group. Run once with sudo. |
| `jarvis-daemon.service.example` | systemd **user** unit template for `daemon.js`. |

## Install

### 1. System dependencies

```sh
bash ~/jarvis/deploy/linux/setup-deps.sh
sudo pacman -S --needed ffmpeg espeak-ng
# Tauri widget only: cargo, webkit2gtk-4.1, gtk3, libsoup3, librsvg
```

### 2. Python venv (voice + memory)

```sh
# follow the venv/ creation in ~/jarvis/README.md (faster-whisper, piper-tts, fastembed)
```

### 3. Node deps

```sh
cd ~/jarvis/server && npm install
```

## Run as a user service (auto-start)

1. Copy + edit the unit:
   ```sh
   cp ~/jarvis/deploy/linux/jarvis-daemon.service.example ~/.config/systemd/user/
   # replace <YOUR_HOME> and <node> path in the ExecStart line
   ```
2. Enable at login:
   ```sh
   systemctl --user enable --now jarvis-daemon
   ```

Manage with `systemctl --user status|restart|stop jarvis-daemon`.

> Note: running as a **user** service (not system) is required — the daemon
> resolves paths from `os.homedir()` and needs the interactive Wayland session
> for desktop-control tools (wtype/ydotool), exactly like the Windows scheduled
> task runs in the logged-in user's session.
