#!/bin/sh
# Manage the existing ScreenMesh kiosk URL without changing its Chromium profile.
set -eu

SERVICE_NAME='videowall-kiosk.service'
PRODUCTION_URL='https://screenmesh.app/?player=1'

die() {
    echo "screenmesh-player-config: $*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: screenmesh-player-config.sh <command> [value]

Commands:
  status                 Show URL, debug state, service state, and config location.
  set-url <http(s) URL>  Save a player URL and restart the kiosk service.
  set-production         Save the current ScreenMesh production player URL and restart.
  enable-debug           Add debug=1 without changing other URL parameters, then restart.
  disable-debug          Remove debug without changing other URL parameters, then restart.
  restart                Restart only the kiosk/player service.
  rollback               Restore the URL saved before the last URL change and restart.

Run as the paired desktop user. If invoked with sudo from that user's shell, the
tool uses sudo's recorded user identity, never root's home or user service. It
never changes the Chromium profile, localStorage, device ID, or pairing token.
EOF
}

CURRENT_UID="$(id -u)"
CURRENT_USER="$(id -un)"
if [ "$CURRENT_UID" = '0' ]; then
    [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != 'root' ] || die 'run this through sudo from the kiosk user, not as root directly'
    [ -n "${SUDO_UID:-}" ] || die 'sudo user identity is incomplete; refusing to guess the kiosk user'
    TARGET_USER="$SUDO_USER"
    TARGET_UID="$(id -u "$TARGET_USER" 2>/dev/null)" || die "sudo user does not exist: $TARGET_USER"
    [ "$TARGET_UID" = "$SUDO_UID" ] || die 'sudo user identity does not match the local account; refusing to continue'
else
    TARGET_USER="$CURRENT_USER"
    TARGET_UID="$CURRENT_UID"
fi

command -v getent >/dev/null 2>&1 || die 'getent is required to resolve the kiosk user home directory'
TARGET_HOME="$(getent passwd "$TARGET_USER" | awk -F: 'NR == 1 { print $6 }')"
case "$TARGET_HOME" in
    /*) ;;
    *) die "could not resolve an absolute home directory for $TARGET_USER" ;;
esac
[ "$TARGET_HOME" != '/root' ] || die 'refusing to use root as the kiosk user home'

CONFIG_DIR="$TARGET_HOME/.config/videowall"
CONFIG_FILE="$CONFIG_DIR/kiosk.env"
PREVIOUS_FILE="$CONFIG_DIR/kiosk.env.previous"

own_for_target_user() {
    if [ "$(id -u)" = '0' ]; then
        chown "$TARGET_USER" "$1"
    fi
}

configured_url() {
    [ -f "$CONFIG_FILE" ] || die "config file not found: $CONFIG_FILE (run kiosk/install.sh first)"
    awk '/^KIOSK_URL=/{ print substr($0, 11); exit }' "$CONFIG_FILE"
}

validate_url() {
    candidate=$1
    case "$candidate" in
        http://?*|https://?*) ;;
        *) die "URL must start with http:// or https://" ;;
    esac
    case "$candidate" in *[[:space:]]*) die "URL must not contain whitespace" ;; esac
    authority=${candidate#*://}
    authority=${authority%%/*}
    authority=${authority%%\?*}
    authority=${authority%%\#*}
    [ -n "$authority" ] || die "URL must include a host"
}

write_url() {
    next_url=$1
    validate_url "$next_url"
    install -d -m 700 "$CONFIG_DIR"
    own_for_target_user "$CONFIG_DIR"
    temporary_file="$(mktemp "$CONFIG_DIR/.kiosk.env.XXXXXX")"
    trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
    awk -v url="$next_url" '
        BEGIN { replaced = 0 }
        /^KIOSK_URL=/ {
            if (!replaced) { print "KIOSK_URL=" url; replaced = 1 }
            next
        }
        { print }
        END { if (!replaced) print "KIOSK_URL=" url }
    ' "$CONFIG_FILE" > "$temporary_file"
    chmod 600 "$temporary_file"
    own_for_target_user "$temporary_file"
    mv "$temporary_file" "$CONFIG_FILE"
    trap - EXIT HUP INT TERM
}

save_previous_url() {
    current_url=$1
    printf 'KIOSK_URL=%s\n' "$current_url" > "$PREVIOUS_FILE"
    chmod 600 "$PREVIOUS_FILE"
    own_for_target_user "$PREVIOUS_FILE"
}

split_url() {
    SPLIT_INPUT=$1
    case "$SPLIT_INPUT" in
        *'#'*) SPLIT_FRAGMENT="#${SPLIT_INPUT#*#}"; SPLIT_BASE=${SPLIT_INPUT%%#*} ;;
        *) SPLIT_FRAGMENT=''; SPLIT_BASE=$SPLIT_INPUT ;;
    esac
    case "$SPLIT_BASE" in
        *\?*) SPLIT_PATH=${SPLIT_BASE%%\?*}; SPLIT_QUERY=${SPLIT_BASE#*\?} ;;
        *) SPLIT_PATH=$SPLIT_BASE; SPLIT_QUERY='' ;;
    esac
}

without_debug() {
    printf '%s\n' "$1" | awk -F '&' '{
        for (i = 1; i <= NF; i++) {
            if ($i !~ /^debug(=|$)/) {
                if (result != "") result = result "&"
                result = result $i
            }
        }
        print result
    }'
}

set_debug() {
    split_url "$1"
    query_without_debug="$(without_debug "$SPLIT_QUERY")"
    if [ -n "$query_without_debug" ]; then
        printf '%s?%s&debug=1%s\n' "$SPLIT_PATH" "$query_without_debug" "$SPLIT_FRAGMENT"
    else
        printf '%s?debug=1%s\n' "$SPLIT_PATH" "$SPLIT_FRAGMENT"
    fi
}

clear_debug() {
    split_url "$1"
    query_without_debug="$(without_debug "$SPLIT_QUERY")"
    if [ -n "$query_without_debug" ]; then
        printf '%s?%s%s\n' "$SPLIT_PATH" "$query_without_debug" "$SPLIT_FRAGMENT"
    else
        printf '%s%s\n' "$SPLIT_PATH" "$SPLIT_FRAGMENT"
    fi
}

debug_enabled() {
    split_url "$1"
    printf '%s\n' "$SPLIT_QUERY" | awk -F '&' '{
        for (i = 1; i <= NF; i++) if ($i == "debug=1") exit 0
        exit 1
    }'
}

user_systemctl() {
    if [ "${SCREENMESH_SKIP_SYSTEMCTL:-0}" = '1' ]; then
        return 0
    fi
    if [ "$TARGET_USER" = "$(id -un)" ]; then
        systemctl --user "$@"
        return
    fi
    command -v runuser >/dev/null 2>&1 || die 'runuser is required when running through sudo'
    runuser -u "$TARGET_USER" -- env "XDG_RUNTIME_DIR=/run/user/$TARGET_UID" \
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$TARGET_UID/bus" systemctl --user "$@"
}

restart_service() {
    if [ "${SCREENMESH_SKIP_SYSTEMCTL:-0}" = '1' ]; then
        echo "Restart skipped for validation ($SERVICE_NAME)."
        return
    fi
    user_systemctl restart "$SERVICE_NAME"
    echo "Restarted $SERVICE_NAME for $TARGET_USER."
}

set_and_restart() {
    new_url=$1
    old_url="$(configured_url)"
    [ -n "$old_url" ] || die "KIOSK_URL is missing from $CONFIG_FILE"
    validate_url "$old_url"
    validate_url "$new_url"
    if [ "$old_url" = "$new_url" ]; then
        echo 'Player URL is already configured; restarting.'
    else
        save_previous_url "$old_url"
        write_url "$new_url"
        echo "Configured player URL: $new_url"
    fi
    restart_service
}

status() {
    current_url="$(configured_url)"
    validate_url "$current_url"
    if debug_enabled "$current_url"; then debug_state='enabled'; else debug_state='disabled'; fi
    if [ "${SCREENMESH_SKIP_SYSTEMCTL:-0}" = '1' ]; then
        service_state='not checked (validation mode)'
    elif user_systemctl is-active --quiet "$SERVICE_NAME"; then
        service_state='active'
    else
        service_state='inactive or unavailable'
    fi
    printf 'Kiosk user: %s\nConfigured player URL: %s\nDebug mode: %s\nService: %s (%s)\nConfig file: %s\n' \
        "$TARGET_USER" "$current_url" "$debug_state" "$SERVICE_NAME" "$service_state" "$CONFIG_FILE"
}

command=${1:-help}
case "$command" in
    help|-h|--help) usage ;;
    status) [ "$#" -eq 1 ] || die 'status takes no arguments'; status ;;
    set-url) [ "$#" -eq 2 ] || die 'usage: set-url <http(s) URL>'; set_and_restart "$2" ;;
    set-production) [ "$#" -eq 1 ] || die 'set-production takes no arguments'; set_and_restart "$PRODUCTION_URL" ;;
    enable-debug) [ "$#" -eq 1 ] || die 'enable-debug takes no arguments'; set_and_restart "$(set_debug "$(configured_url)")" ;;
    disable-debug) [ "$#" -eq 1 ] || die 'disable-debug takes no arguments'; set_and_restart "$(clear_debug "$(configured_url)")" ;;
    restart) [ "$#" -eq 1 ] || die 'restart takes no arguments'; restart_service ;;
    rollback)
        [ "$#" -eq 1 ] || die 'rollback takes no arguments'
        [ -f "$PREVIOUS_FILE" ] || die "no previous URL is available at $PREVIOUS_FILE"
        previous_url="$(awk '/^KIOSK_URL=/{ print substr($0, 11); exit }' "$PREVIOUS_FILE")"
        [ -n "$previous_url" ] || die "previous URL is missing from $PREVIOUS_FILE"
        set_and_restart "$previous_url"
        echo "Rolled back to: $previous_url"
        ;;
    *) usage >&2; die "unknown command: $command" ;;
esac
