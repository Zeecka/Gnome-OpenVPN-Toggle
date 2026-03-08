#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC_DIR="$REPO_ROOT/src"
META="$SRC_DIR/metadata.json"
DIST_DIR="$REPO_ROOT/dist"
BUILD_DIR="$REPO_ROOT/.build"
TMP_DIR="$BUILD_DIR/ego"

for cmd in gnome-extensions glib-compile-schemas python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
done

if [ ! -f "$META" ]; then
  echo "metadata.json not found at src/metadata.json"
  exit 1
fi

UUID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["uuid"])' "$META")"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$META")"

REQUIRED=(
  "src/metadata.json"
  "src/extension.js"
  "src/prefs.js"
  "src/stylesheet.css"
  "src/scripts/askpass.exp"
  "src/scripts/askpin.exp"
  "src/schemas/org.gnome.shell.extensions.gnome-openvpn-toggle.gschema.xml"
)

for rel in "${REQUIRED[@]}"; do
  if [ ! -e "$REPO_ROOT/$rel" ]; then
    echo "Missing required file: $rel"
    exit 1
  fi
done

mkdir -p "$DIST_DIR" "$TMP_DIR"
rm -rf "$TMP_DIR"/*

cp -r "$SRC_DIR/metadata.json" "$TMP_DIR/"
cp -r "$SRC_DIR/extension.js" "$TMP_DIR/"
cp -r "$SRC_DIR/prefs.js" "$TMP_DIR/"
cp -r "$SRC_DIR/stylesheet.css" "$TMP_DIR/"
cp -r "$SRC_DIR/scripts" "$TMP_DIR/"
cp -r "$SRC_DIR/schemas" "$TMP_DIR/"

chmod +x "$TMP_DIR/scripts/askpass.exp" "$TMP_DIR/scripts/askpin.exp"
glib-compile-schemas "$TMP_DIR/schemas"

cd "$TMP_DIR"
gnome-extensions pack --force --out-dir "$DIST_DIR"

DEFAULT_ZIP="$DIST_DIR/$UUID.shell-extension.zip"
TARGET_ZIP="$DIST_DIR/$UUID-v$VERSION.zip"

if [ -f "$DEFAULT_ZIP" ]; then
  mv -f "$DEFAULT_ZIP" "$TARGET_ZIP"
else
  GENERATED="$(find "$DIST_DIR" -maxdepth 1 -type f -name '*.zip' -printf '%T@ %p\n' | sort -n | tail -n 1 | cut -d' ' -f2-)"
  if [ -n "$GENERATED" ] && [ -f "$GENERATED" ]; then
    mv -f "$GENERATED" "$TARGET_ZIP"
  else
    echo "Build failed: no zip artifact found"
    exit 1
  fi
fi

echo "Build complete: $TARGET_ZIP"
echo "Next: upload this zip to extensions.gnome.org"
