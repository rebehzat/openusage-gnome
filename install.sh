#!/usr/bin/env bash
# OpenUsage for GNOME — installer
set -euo pipefail

EXT_UUID="openusage@foxxy"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$EXT_UUID"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing $EXT_UUID to $DEST"
mkdir -p "$DEST" "$ICON_DIR"
cp -r "$SRC_DIR/$EXT_UUID/." "$DEST/"
cp "$SRC_DIR/icons/openusage-symbolic.svg" "$ICON_DIR/"

echo "==> Compiling GSettings schema"
glib-compile-schemas "$DEST/schemas/"

echo "==> Updating icon cache"
gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true

echo "==> Enabling extension (appended, existing ones kept)"
new_list="$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null | python3 -c "
import ast, sys
uuid = '$EXT_UUID'
raw = sys.stdin.read().strip()
try:
    lst = ast.literal_eval(raw) if raw else []
except Exception:
    lst = []
if uuid not in lst:
    lst.append(uuid)
print('[' + ', '.join(repr(x) for x in lst) + ']')
")"
gsettings set org.gnome.shell enabled-extensions "$new_list"

echo
echo "✅ Installed. Log out and back in (Wayland), then look for the meter in the top bar."
echo "   Settings: right-click the panel item → OpenUsage Settings…"
