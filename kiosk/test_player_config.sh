#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TOOL="$ROOT/screenmesh-player-config.sh"
TEMP_DIR=$(mktemp -d)
MOCK_BIN="$TEMP_DIR/bin"
CURRENT_USER=$(id -un)
CURRENT_UID=$(id -u)
TARGET_HOME="$TEMP_DIR/paired-home"
CONFIG_DIR="$TARGET_HOME/.config/videowall"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM
mkdir -p "$MOCK_BIN" "$CONFIG_DIR"

printf '%s\n' '#!/bin/sh' \
    'case "$1" in' \
    '  -u) if [ "$#" -eq 2 ]; then printf "%s\\n" "$MOCK_UID"; else printf "%s\\n" "$MOCK_EUID"; fi ;;' \
    '  -un) printf "%s\\n" "$MOCK_USER" ;;' \
    '  *) exit 1 ;;' \
    'esac' > "$MOCK_BIN/id"
printf '%s\n' '#!/bin/sh' \
    '[ "$1" = passwd ] && [ "$2" = "$MOCK_USER" ] || exit 2' \
    'printf "%s:x:%s:1000::%s:/bin/sh\\n" "$MOCK_USER" "$MOCK_UID" "$MOCK_HOME"' > "$MOCK_BIN/getent"
chmod 755 "$MOCK_BIN/id" "$MOCK_BIN/getent"

write_config() {
    printf '%s\n' "$1" > "$CONFIG_DIR/kiosk.env"
}

run_tool() {
    HOME=/root PATH="$MOCK_BIN:$PATH" MOCK_EUID="$CURRENT_UID" MOCK_UID="$CURRENT_UID" \
        MOCK_USER="$CURRENT_USER" MOCK_HOME="$TARGET_HOME" SCREENMESH_SKIP_SYSTEMCTL=1 sh "$TOOL" "$@"
}

run_tool_through_sudo() {
    sudo -n env HOME=/root "PATH=$MOCK_BIN:$PATH" MOCK_EUID=0 MOCK_UID="$CURRENT_UID" \
        MOCK_USER="$CURRENT_USER" MOCK_HOME="$TARGET_HOME" "SUDO_USER=$CURRENT_USER" \
        "SUDO_UID=$CURRENT_UID" SCREENMESH_SKIP_SYSTEMCTL=1 sh "$TOOL" "$@"
}

assert_url() {
    expected=$1
    actual=$(awk -F= '/^KIOSK_URL=/{ print substr($0, 11); exit }' "$CONFIG_DIR/kiosk.env")
    [ "$actual" = "$expected" ] || { echo "expected $expected, got $actual" >&2; exit 1; }
}

write_config 'KIOSK_URL=https://example.test/?player=1&safe=1#screen'
normal_status=$(run_tool status)
printf '%s\n' "$normal_status" | grep -F "Kiosk user: $CURRENT_USER" >/dev/null
printf '%s\n' "$normal_status" | grep -F "Config file: $CONFIG_DIR/kiosk.env" >/dev/null
if printf '%s\n' "$normal_status" | grep -F '/root/.config/videowall' >/dev/null; then
    echo 'normal invocation used root config path' >&2
    exit 1
fi
run_tool enable-debug >/dev/null
assert_url 'https://example.test/?player=1&safe=1&debug=1#screen'
run_tool disable-debug >/dev/null
assert_url 'https://example.test/?player=1&safe=1#screen'
run_tool set-url 'https://screenmesh.app/?player=1&rawVideo=1' >/dev/null
assert_url 'https://screenmesh.app/?player=1&rawVideo=1'
run_tool rollback >/dev/null
assert_url 'https://example.test/?player=1&safe=1#screen'
run_tool set-url 'http://player.lan/?player=1' >/dev/null
assert_url 'http://player.lan/?player=1'
if run_tool set-url 'ftp://example.test/player' >/dev/null 2>&1; then
    echo 'invalid scheme was accepted' >&2
    exit 1
fi
run_tool status | grep -F 'Debug mode: disabled' >/dev/null
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo_status=$(run_tool_through_sudo status)
    printf '%s\n' "$sudo_status" | grep -F "Kiosk user: $CURRENT_USER" >/dev/null
    printf '%s\n' "$sudo_status" | grep -F "Config file: $CONFIG_DIR/kiosk.env" >/dev/null
    if printf '%s\n' "$sudo_status" | grep -F '/root/.config/videowall' >/dev/null; then
        echo 'sudo invocation used root config path' >&2
        exit 1
    fi
    run_tool_through_sudo enable-debug >/dev/null
    [ "$(stat -c '%u' "$CONFIG_DIR/kiosk.env")" = "$CURRENT_UID" ] || {
        echo 'sudo write changed config ownership' >&2
        exit 1
    }
    run_tool_through_sudo disable-debug >/dev/null
    if sudo -n env -u SUDO_USER -u SUDO_UID HOME=/root "PATH=$MOCK_BIN:$PATH" MOCK_EUID=0 MOCK_UID="$CURRENT_UID" \
        MOCK_USER="$CURRENT_USER" MOCK_HOME="$TARGET_HOME" SCREENMESH_SKIP_SYSTEMCTL=1 sh "$TOOL" status >/dev/null 2>&1; then
        echo 'direct root invocation was accepted' >&2
        exit 1
    fi
else
    echo 'sudo path test skipped: passwordless sudo is unavailable'
fi
echo 'screenmesh player config tests passed'
