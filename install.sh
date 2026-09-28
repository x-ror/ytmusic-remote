#!/bin/bash
# Install YouTube Music Remote (a GNOME Shell extension) for this user.
#
#   ./install.sh               install or update the extension
#   ./install.sh --with-app    also download and install the YouTube Music app
#                              (pear-desktop .deb from GitHub; asks for sudo)
#   ./install.sh --uninstall   remove the extension and its menu entry
#
# What it changes, all in your home folder:
#   ~/.local/share/gnome-shell/extensions/ytmusic-remote@andrii   the extension
#   ~/.local/share/applications/com.github.th-ch.youtube-music.desktop
#       a "YouTube Music" menu entry that starts the app through the
#       extension's private bridge, so the remote can always reach it
#   ~/.config/YouTube Music/config.json   options.resumeOnStart = false, so
#       the app never starts music by itself (the remote resumes instead)
set -euo pipefail

UUID="ytmusic-remote@andrii"
here=$(cd "$(dirname "$0")" && pwd)
src="$here/$UUID"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
# The user entry takes the packaged entry's file name, which hides the packaged
# one from the app grid (so there is one "YouTube Music", and it goes through
# the bridge).
packaged=$(grep -lE '^Exec=.*(YouTube Music/youtube-music|/usr/bin/youtube-music|pear-desktop)' \
    /usr/share/applications/*.desktop 2>/dev/null | head -1 || true)
entry="$apps/$(basename "${packaged:-com.github.th-ch.youtube-music.desktop}")"
app_cfg="${XDG_CONFIG_HOME:-$HOME/.config}/YouTube Music/config.json"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

app_running() { pgrep -f "/opt/YouTube Music/youtube-music" >/dev/null 2>&1; }

uninstall() {
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf -- "$dest"
    local f
    for f in "$apps"/*.desktop; do
        [[ -f $f ]] && grep -q "ytmusic-remote GNOME extension" "$f" && rm -f -- "$f"
    done
    say "Removed YouTube Music Remote."
    note "The app itself and its settings are untouched."
}

install_app() {
    local arch url tmp
    arch=$(dpkg --print-architecture)
    say "Looking up the latest pear-desktop release…"
    url=$(curl -fsSL https://api.github.com/repos/pear-devs/pear-desktop/releases/latest \
        | python3 -c "import json,sys; a=[x['browser_download_url'] for x in json.load(sys.stdin)['assets'] if x['name'].endswith('_$arch.deb')]; print(a[0] if a else '')")
    if [[ -z $url ]]; then
        note "No .deb for $arch in the latest release. Get it by hand: https://github.com/pear-devs/pear-desktop/releases"
        return 1
    fi
    tmp=$(mktemp -d)
    say "Downloading $(basename "$url")…"
    curl -fL --progress-bar -o "$tmp/$(basename "$url")" "$url"
    say "Installing it (sudo asks for your password)…"
    sudo apt-get install -y "$tmp/$(basename "$url")"
    rm -rf -- "$tmp"
}

if [[ ${1:-} == --uninstall ]]; then uninstall; exit 0; fi

# GNOME 45 or newer.
ver=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
if [[ -z $ver ]]; then
    say "GNOME Shell was not found. This extension is for the GNOME desktop (Ubuntu's default)."
    exit 1
fi
if (( ver < 45 )); then
    say "GNOME Shell $ver is too old: the extension needs 45 or newer (Ubuntu 23.10+, 24.04 LTS is fine)."
    exit 1
fi
command -v python3 >/dev/null || { say "python3 is missing: sudo apt install python3"; exit 1; }

if [[ ${1:-} == --with-app ]]; then install_app; fi

say "Installing the extension…"
mkdir -p -- "$(dirname "$dest")"
rm -rf -- "$dest"
cp -r -- "$src" "$dest"
chmod +x "$dest/tools/cdp-bridge"
glib-compile-schemas "$dest/schemas"
note "$dest"

say "Adding the YouTube Music menu entry…"
mkdir -p -- "$apps"
cat > "$entry" <<EOF
[Desktop Entry]
Name=YouTube Music
Comment=YouTube Music, started for the ytmusic-remote GNOME extension (private debugging pipe, no port)
Exec=python3 "$dest/tools/cdp-bridge" %U
Terminal=false
Type=Application
Icon=youtube-music
StartupWMClass=com.github.th-ch.youtube-music
Categories=AudioVideo;Audio;
Actions=sign-in;

# Google refuses to sign in while the debugging pipe is on, so signing in
# goes through a plain start of the app (see tools/cdp-bridge --sign-in).
[Desktop Action sign-in]
Name=Sign in to Google
Exec=python3 "$dest/tools/cdp-bridge" --sign-in
EOF
note "$entry"
# A separate sign-in entry from an earlier version showed a second icon.
rm -f -- "$apps/ytmusic-remote-sign-in.desktop"

if [[ -f $app_cfg ]]; then
    if app_running; then
        note "YouTube Music is running, so its resume-on-start option was left as is."
        note "Quit it and run this again to have the remote do the resuming."
    else
        python3 - "$app_cfg" <<'PY'
import json, os, sys, tempfile
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)
opts = cfg.setdefault("options", {})
if opts.get("resumeOnStart") is not False:
    opts["resumeOnStart"] = False
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    print("  Turned off the app's own resume-on-start (the remote resumes where you left off).")
PY
    fi
fi

if [[ ! -x "/opt/YouTube Music/youtube-music" && ! -x "/usr/bin/youtube-music" ]]; then
    say "The YouTube Music app (pear-desktop) is not installed yet."
    note "Run:  ./install.sh --with-app"
    note "or get the .deb from https://github.com/pear-devs/pear-desktop/releases"
    note "(an AppImage works too: choose it in the extension's settings)."
fi

# Enable it. A brand-new extension is only picked up by GNOME Shell after
# logging out and in on Wayland, so it is also added to the enabled list.
gnome-extensions enable "$UUID" 2>/dev/null || true
if command -v gsettings >/dev/null; then
    list=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null || echo "[]")
    if [[ $list != *"$UUID"* ]]; then
        if [[ $list == "@as []" || $list == "[]" ]]; then new="['$UUID']"; else new="${list%]}, '$UUID']"; fi
        gsettings set org.gnome.shell enabled-extensions "$new" 2>/dev/null || true
    fi
fi

say "Done."
if gnome-extensions info "$UUID" 2>/dev/null | grep -q "State: ACTIVE"; then
    note "The remote is in the top bar now."
else
    note "Log out and back in once; the remote then appears in the top bar."
fi
note "First time: right-click YouTube Music in the app menu, choose \"Sign in to Google\", sign in, then quit it."
