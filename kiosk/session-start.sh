#!/bin/sh
set -eu
: "${XDG_RUNTIME_DIR:?Run this from labwc autostart}"
: "${WAYLAND_DISPLAY:?Run this from labwc autostart}"
systemctl --user import-environment WAYLAND_DISPLAY XDG_RUNTIME_DIR DISPLAY DBUS_SESSION_BUS_ADDRESS
systemctl --user restart videowall-kiosk.service
