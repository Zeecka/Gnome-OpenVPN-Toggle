#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$REPO_ROOT/src"

UUID="gnome-openvpn-toggle@zeecka"
SCHEMA_ID="org.gnome.shell.extensions.gnome-openvpn-toggle"
DCONF_PATH="/org/gnome/shell/extensions/gnome-openvpn-toggle/"

DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" || true

# Delete extension preferences/data
dconf reset -f "$DCONF_PATH" 2>/dev/null || true
gsettings reset-recursively "$SCHEMA_ID" 2>/dev/null || true

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC_DIR/metadata.json" "$SRC_DIR/extension.js" "$SRC_DIR/prefs.js" "$SRC_DIR/stylesheet.css" "$SRC_DIR/scripts" "$SRC_DIR/schemas" "$DEST/"

glib-compile-schemas "$DEST/schemas/"
chmod +x "$DEST/scripts/askpass.exp" "$DEST/scripts/askpin.exp"

read -p "Alt+F2, type 'r', and press enter to reload GNOME Shell..."
gnome-extensions enable "$UUID"
