#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
    echo 'Run as the desktop autologin user, without sudo.' >&2
    exit 1
fi
cd "$(dirname "$0")"
for command in chromium python3 wayland-info systemctl; do
    command -v "$command" >/dev/null
done
python3 -c 'import websocket'
install -d "$HOME/.local/lib/videowall" "$HOME/.config/videowall" "$HOME/.config/systemd/user" "$HOME/.config/labwc"
install -m 755 launcher.py session-start.sh "$HOME/.local/lib/videowall/"
install -m 644 videowall-kiosk.service "$HOME/.config/systemd/user/"
if [ ! -f "$HOME/.config/videowall/kiosk.env" ]; then
    install -m 600 kiosk.env "$HOME/.config/videowall/kiosk.env"
fi
autostart="$HOME/.config/labwc/autostart"
if [ -f "$autostart" ]; then
    cp -p "$autostart" "$autostart.backup.$(date +%Y%m%d%H%M%S)"
fi
touch "$autostart"
line='"$HOME/.local/lib/videowall/session-start.sh" &'
if ! grep -Fqx "$line" "$autostart"; then
    printf '\n%s\n' "$line" >> "$autostart"
fi
systemctl --user daemon-reload
echo 'Installed. Remove older Chromium/kiosk autostarts, then reboot. See docs/raspberry-pi-kiosk.md.'
