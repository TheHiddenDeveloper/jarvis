#!/usr/bin/env bash
# Jarvis system dependency setup (Manjaro/Arch + Wayland).
# Run once:  bash ~/jarvis/deploy/linux/setup-deps.sh
set -euo pipefail

echo "==> Installing Wayland automation tools (requires sudo)"
sudo pacman -S --needed wtype grim slurp wl-clipboard ydotool

echo "==> Installing tesseract language data (eng + keeping afr)"
sudo pacman -S --needed tesseract-data-eng

echo "==> Boosting headset mic gain (Logitech USB headset is very quiet)"
pactl set-source-volume default 120% || true
echo "    (JARVIS_MIC or 'pactl set-source-volume' can override later)"

echo "==> Adding $USER to 'input' group (for ydotool uinput access)"
sudo usermod -aG input "$USER"

echo "==> Reloading udev rules (package ships 80-uinput.rules)"
sudo udevadm control --reload-rules && sudo udevadm trigger

echo "==> Enabling ydotool daemon (user service)"
systemctl --user enable --now ydotool.service

echo "==> Done."
echo "    NOTE: If ydotool still can't access uinput, log out and back in"
echo "    so the 'input' group applies. Verify with:  ydotool mousemove --absolute --x 500 --y 500"
