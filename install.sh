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

# --- Antigravity CLI (agy) statusline hook -----------------------------------
HOOK_SRC="$SRC_DIR/statusline/agy-statusline"
HOOK_DST="$HOME/.local/bin/agy-openusage-statusline"
AGY_SETTINGS="$HOME/.gemini/antigravity-cli/settings.json"
if [ -f "$HOOK_SRC" ]; then
    echo "==> Installing Antigravity statusline hook"
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$HOOK_SRC" "$HOOK_DST"
    AGY_SETTINGS="$AGY_SETTINGS" HOOK_DST="$HOOK_DST" python3 - << 'PYEOF'
import json, os
path = os.environ["AGY_SETTINGS"]
hook = os.environ["HOOK_DST"]
os.makedirs(os.path.dirname(path), exist_ok=True)
cfg = {}
if os.path.exists(path):
    try:
        cfg = json.load(open(path))
    except Exception:
        cfg = {}
sl = cfg.get("statusLine") or {}
cmd = str(sl.get("command", ""))
if cmd and "agy-openusage-statusline" not in cmd:
    print("   ! statusLine.command already set to something else — leaving it alone")
else:
    cfg["statusLine"] = {
        "type": "command",
        "command": f'"{hook}" antigravity statusline',
        "enabled": True,
        "stack_with_default": True,
    }
    json.dump(cfg, open(path, "w"), indent=2)
    open(path, "a").write("\n")
    print("   ✓ agy statusLine configured")
PYEOF
fi

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
