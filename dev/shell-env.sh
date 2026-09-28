# Source this: the nested test shell's environment.
export XDG_RUNTIME_DIR=/tmp/ytmr-rt
export HOME=/tmp/ytmr-home
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share XDG_CACHE_HOME=$HOME/.cache XDG_STATE_HOME=$HOME/.local/state
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
export DEV=/home/claude/ytmusic-gnome/dev EXT=/home/claude/ytmusic-gnome/ytmusic-remote@andrii
export SHOTS=/tmp/claude-0/-home-claude/e66606d9-8e33-5e3f-8be6-d1a6e1fa0e2e/scratchpad/shots
ev() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
shot() { gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot false false "$SHOTS/$1.png" >/dev/null && echo "$SHOTS/$1.png"; }
