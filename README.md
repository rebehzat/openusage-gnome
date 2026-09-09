# OpenUsage for GNOME

AI plan usage meters in your GNOME top bar. Track how much of your subscription
you have **left** — bars, reset countdowns, and a panel label like `91% left`.

Tracks:
- **OpenAI Codex (ChatGPT)** — 5h + weekly rate-limit windows, extra metered
  features (e.g. `gpt-reserve`), credits, plan tier. Reads `~/.codex/auth.json`
  automatically, then polls ChatGPT's live usage endpoint.
- **Z.AI GLM Coding Plan** — 5h and weekly credit windows (new `CREDIT_LIMIT`
  format), plan level, credit grants, China/Global regions.
- **OpenCode Go** — rolling / weekly / monthly usage via the API-key
  authenticated `GET /zen/go/v1/usage` endpoint (no browser cookie needed).
  Zen catalog auth status shown too. Optional console-cookie billing
  (balance / monthly limit) is still supported.

Provider logic is ported from
[janekbaraniewski/openusage](https://github.com/janekbaraniewski/openusage) (Go)
to GJS, plus new endpoints discovered since (OpenCode Go usage).

![GNOME 50](https://img.shields.io/badge/GNOME-49%20%7C%2050-blue)

## Install

```bash
git clone https://github.com/rebehzat/openusage-gnome
cd openusage-gnome
./install.sh
```

Then **log out and back in** (Wayland cannot hot-load extensions), or run
`gnome-extensions enable openusage@foxxy` on an X11 session.

`install.sh` copies the extension to `~/.local/share/gnome-shell/extensions/`,
compiles the GSettings schema, installs the icon, and appends the extension to
your `enabled-extensions`.

## Usage

Click the panel item for the full breakdown. Right-click → *OpenUsage Settings…*
for options:

| Key | Default | Description |
|-----|---------|-------------|
| `refresh-interval` | 300 s | Polling interval (min 60 s) |
| `warn-threshold` | 80 | Panel turns orange/red when usage crosses this |
| `show-label` | true | Show `% left` in the panel |
| `show-codex` / `show-zai` / `show-opencode` | true | Provider toggles |
| `zai-api-key` | `""` | Z.AI key (see below) |
| `zai-region` | global | `global` (api.z.ai) or `china` (open.bigmodel.cn) |
| `opencode-cookie` | `""` | Optional console cookie for $ billing |
| `chatgpt-base-url` | `""` | ChatGPT backend override |

### Where credentials come from

- **Codex** — nothing to configure; uses `~/.codex/auth.json` written by the
  Codex CLI. Tokens never leave your machine except to `chatgpt.com`.
- **Z.AI** — the extension checks, in order: the `zai-api-key` setting, the
  `ZAI_API_KEY` / `ZHIPUAI_API_KEY` environment variables, and finally the file
  `~/.config/zai` (plain file containing just the key). Get a key at
  [z.ai](https://z.ai), Coding Plan recommended.
- **OpenCode** — reads API keys from `~/.local/share/opencode/auth.json`
  (entries `opencode` / `opencode-go`) or `OPENCODE_API_KEY`. The Go-plan usage
  meter works with just the API key.

## Endpoints used

| Provider | Endpoint | Auth |
|----------|----------|------|
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` | Bearer (auth.json) |
| Z.AI | `GET <monitor>/api/monitor/usage/quota/limit` | raw key, Bearer fallback |
| Z.AI | `GET <monitor>/api/paas/v4/user/credit_grants` | same |
| Z.AI | `GET <coding>/api/coding/paas/v4/models` | same |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | Bearer API key |
| OpenCode Zen | `GET https://opencode.ai/zen/v1/models` | Bearer API key |
| OpenCode console (optional) | `GET https://opencode.ai/_server` (`queryBillingInfo` server-fn) | session cookie |

## Development

The data layer is framework-free and testable outside GNOME Shell:

```bash
cd test
gjs -m run.js       # unit + live tests (live only when local credentials exist)
gjs -m zai-live.js  # Z.AI end-to-end (reads ~/.config/zai)
gjs -m oc-live.js   # OpenCode end-to-end (reads ~/.local/share/opencode/auth.json)
```

## Credits

- [openusage](https://github.com/janekbaraniewski/openusage) — provider logic,
  seroval parser approach, pinned server-fn IDs.

## License

MIT — see [LICENSE](LICENSE).
