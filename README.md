# OpenUsage for GNOME

Show **ChatGPT**, **Grok Build**, and **Grok Bot** weekly remaining usage in
the GNOME top bar and menu. The panel averages the weekly allowances that
reported a number. The menu shows each one, with its reset countdown.

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
| Grok Build | `grok login` | The Grok CLI session in `~/.grok/auth.json` (`GROK_HOME` when set). Usage is the shared weekly credit pool from `https://cli-chat-proxy.grok.com/v1/billing?format=credits`, with the same `GetGrokCreditsConfig` fallback the CLI uses when that response omits the percent. |
| Grok Bot | the Grok Bot app | The app session in `~/.config/Grok Bot/sand-secrets.json`, unlocked with the Grok Bot keyring item. Usage comes from Grok Bot's weekly included allowance. |

A file-based sign-in is required. API keys cannot supply these plan meters.
The extension never modifies credentials or refreshes OAuth tokens. When a
Grok CLI or Codex token expires, sign in again with that CLI. Only the weekly
window is displayed. Missing weekly data is shown as unavailable, and an
omitted percent is not treated as zero unless the CLI's own fallback says the
period is active and unused.

An optional `chatgpt-base-url` GSettings override supports trusted custom
ChatGPT backends; the bearer token is sent to the configured endpoint.

## Settings

Open the panel menu → **OpenUsage Settings…** to configure the refresh
interval (default 300 seconds), warning threshold (default 80% used), and panel label.

## Development

```bash
gjs -m test/codex-auth.js
gjs -m test/run.js
gjs -m test/run.js --live  # requires Codex, Grok CLI, and Grok Bot sign-in
glib-compile-schemas --strict --dry-run openusage@foxxy/schemas
```

## Credits

Codex usage parsing was adapted from
[janekbaraniewski/openusage](https://github.com/janekbaraniewski/openusage).
MIT — see [LICENSE](LICENSE).
