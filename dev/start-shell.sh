#!/bin/bash
# Start a headless GNOME Shell with the extension, the test helper and the mock app.
. "$(dirname "$0")/shell-env.sh"
pkill -f "[g]nome-shell --headless" 2>/dev/null; pkill -f "[c]dp-bridge" 2>/dev/null; pkill -f "[y]tmr-mock-profile" 2>/dev/null
sleep 1
rm -rf "$XDG_RUNTIME_DIR"; mkdir -p -m 700 "$XDG_RUNTIME_DIR"; mkdir -p "$HOME" "$SHOTS"
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions"
ln -sfn "$EXT" "$XDG_DATA_HOME/gnome-shell/extensions/ytmusic-remote@andrii"
ln -sfn "$DEV/test-ext/ytmr-test@dev" "$XDG_DATA_HOME/gnome-shell/extensions/ytmr-test@dev"
glib-compile-schemas "$EXT/schemas"
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile >/dev/null
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['ytmr-test@dev', 'ytmusic-remote@andrii']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
gsettings set org.gnome.desktop.interface color-scheme "${SCHEME:-prefer-dark}"
gsettings --schemadir "$EXT/schemas" set org.gnome.shell.extensions.ytmusic-remote app-path "$DEV/mock/mock-app"
gsettings --schemadir "$EXT/schemas" set org.gnome.shell.extensions.ytmusic-remote idle-minutes "${IDLE:-10}"
MOCK_HEADFUL=${MOCK_HEADFUL:-} nohup gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x900 > "$SHOTS/../shell.log" 2>&1 &
for i in $(seq 1 60); do ev "1" >/dev/null 2>&1 && break; sleep 0.5; done
ev "Main.layoutManager._startingUp"
