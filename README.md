# OpenUsage for GNOME

Show **ChatGPT** and **OpenCode Go** remaining usage in the GNOME top bar and
menu. The panel averages the weekly allowances that reported a number. The menu
shows each one, with its reset countdown.

## Install

```bash
git clone https://github.com/rebehzat/openusage-gnome
cd openusage-gnome
./install.sh
```

On Wayland, **log out and back in** to load updated extension code.
The installer copies the extension into
`~/.local/share/gnome-shell/extensions/openusage@foxxy`, compiles its settings,
installs its icon, and enables it.

## Sign-in

| Meter | Sign in with | What is read |
| --- | --- | --- |
| ChatGPT | `codex login` | `tokens.access_token` and `tokens.account_id` in `~/.codex/auth.json` (`CODEX_HOME` when GNOME Shell has it set). Usage comes from `https://chatgpt.com/backend-api/wham/usage`. |
| OpenCode Go | `/connect` in OpenCode → **OpenCode Go** | The `opencode-go` API key the OpenCode CLI stores. Usage comes from `https://opencode.ai/zen/go/v1/usage`. |

A file-based sign-in is required. API keys cannot supply the ChatGPT plan
meter. The extension never modifies credentials or refreshes OAuth tokens. When
a Codex token expires, sign in again with `codex login`; when the OpenCode Go key
is rejected, sign in again with `/connect`. The ChatGPT meter shows the weekly
window; OpenCode Go shows its rolling 5-hour, weekly and monthly windows.
Missing data is shown as unavailable, and a percent the endpoint did not report
is never treated as zero.

The OpenCode Go key is looked up in this order, and the first hit wins:

1. `opencode auth export opencode-go` — the official export. The `opencode`
   binary is searched on `PATH` and in `~/.opencode/bin`, `~/.local/bin` and
   `~/.bun/bin`, so it is found even when the GNOME session did not inherit the
   shell `PATH`.
2. The `credential` table of `opencode.db` / `opencode-next.db` in
   `~/.local/share/opencode` (`XDG_DATA_HOME` when set) — where OpenCode 2 keeps
   its credentials.
3. `~/.local/share/opencode/auth.json` — where OpenCode 1 kept its API keys.

OpenCode 2 owns the credential once it has imported the legacy `auth.json`, so
logging out of Go is respected instead of being revived by the old file.

An optional `chatgpt-base-url` GSettings override supports trusted custom
ChatGPT backends; the bearer token is sent to the configured endpoint.

## Settings

Open the panel menu → **OpenUsage Settings…** to configure the refresh
interval (default 300 seconds), warning threshold (default 80% used), and panel label.

## Development

```bash
gjs -m test/codex-auth.js
gjs -m test/opencode-auth.js
gjs -m test/run.js
gjs -m test/run.js --live  # requires Codex and OpenCode Go sign-in
glib-compile-schemas --strict --dry-run openusage@foxxy/schemas
```

## Credits

Codex usage parsing was adapted from
[janekbaraniewski/openusage](https://github.com/janekbaraniewski/openusage).
MIT — see [LICENSE](LICENSE).
