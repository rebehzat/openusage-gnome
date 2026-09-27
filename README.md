# OpenUsage for GNOME

GNOME top-bar meters for **OpenAI Codex** and **OpenCode Go**, using your
[pi coding agent](https://github.com/badlogic/pi-mono) accounts. The panel
shows remaining usage; the menu shows rate-limit windows and reset countdowns.
No Claude, Z.AI, Zen, browser cookies, or separate API-key configuration.

## Install

```bash
git clone https://github.com/rebehzat/openusage-gnome
cd openusage-gnome
./install.sh
```

On Wayland, **log out and back in** to load a newly installed extension.
`install.sh` installs to `~/.local/share/gnome-shell/extensions/openusage@foxxy`,
compiles its GSettings schema, installs its icon, and enables the extension.

## Accounts

Sign in to both providers using pi. The extension reads these named entries
from `~/.pi/agent/auth.json` on each refresh:

| Pi account | Usage endpoint |
|------------|----------------|
| `openai-codex` (OAuth) | `GET https://chatgpt.com/backend-api/wham/usage` |
| `opencode-go` (API key) | `GET https://opencode.ai/zen/go/v1/usage` |

You can override pi's agent directory with `PI_CODING_AGENT_DIR` **in GNOME
Shell's environment**. Only those two accounts are read; tokens are sent only
to their provider's usage endpoint. The extension never writes your pi auth
file or refreshes expired OAuth tokens: re-authenticate in pi when prompted.
A `chatgpt-base-url` GSettings override is available for custom Codex
backends; avoid untrusted URLs, since the bearer token is sent there.

## Settings

Open the panel menu → **OpenUsage Settings…** to configure the refresh
interval (default 300 s), usage warning threshold (default 80%), panel label,
and individual provider switches.

## Development

```bash
gjs -m test/pi-auth.js  # credential parsing fixtures, no network
gjs -m test/run.js      # live endpoint checks; requires pi accounts
glib-compile-schemas --strict --dry-run openusage@foxxy/schemas
```

## Credits

Codex usage parsing was adapted from
[janekbaraniewski/openusage](https://github.com/janekbaraniewski/openusage).
MIT — see [LICENSE](LICENSE).
