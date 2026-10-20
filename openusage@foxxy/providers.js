// ChatGPT weekly usage from the Codex CLI sign-in, and OpenCode Go usage from
// the API key the OpenCode CLI stores for the Go subscription.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const decoder = new TextDecoder();
const pct = v => Math.max(0, Math.min(100, v));
const numeric = v => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function mkSession(timeoutSec = 15) {
    return new Soup.Session({timeout: timeoutSec, user_agent: 'openusage-gnome/1.0'});
}

async function request(session, method, url, headers, body = null, contentType = null) {
    const msg = Soup.Message.new(method, url);
    for (const [name, value] of Object.entries(headers))
        msg.get_request_headers().append(name, value);
    if (body)
        msg.set_request_body_from_bytes(contentType, new GLib.Bytes(body));
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, result) => {
            try {
                const bytes = s.send_and_read_finish(result);
                const raw = bytes?.get_data?.() ?? new Uint8Array();
                resolve({status: msg.status_code, body: decoder.decode(raw), raw});
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function get(session, url, headers) {
    return request(session, 'GET', url, headers);
}

export function codexAuthPath() {
    const dir = GLib.getenv('CODEX_HOME') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
    return GLib.build_filenamev([dir, 'auth.json']);
}

export function readAuthFile(path = codexAuthPath()) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        const data = ok ? JSON.parse(decoder.decode(bytes)) : null;
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

export function readCodexAuth(auth = readAuthFile()) {
    const tokens = auth.tokens;
    if (typeof tokens?.access_token !== 'string' || !tokens.access_token.trim())
        return null;
    let expired = false;
    try {
        const part = tokens.access_token.split('.')[1];
        const claims = JSON.parse(decoder.decode(GLib.base64_decode(
            part.replace(/-/g, '+').replace(/_/g, '/'))));
        expired = typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now();
    } catch {
        // The endpoint also validates opaque tokens and reports expired credentials.
    }
    return {
        accessToken: tokens.access_token,
        accountId: typeof tokens.account_id === 'string' ? tokens.account_id : null,
        expired,
    };
}

function windowLabel(minutes) {
    if (!minutes)
        return 'window';
    if (minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes % 60 === 0)
        return `${minutes / 60}h`;
    return `${minutes}m`;
}

export function parseCodexUsage(payload) {
    const root = payload.rate_limit_status ?? payload;
    const rate = root.rate_limit ?? payload.rate_limit ?? {};
    const windows = [];
    for (const [key, value] of [['primary', rate.primary_window ?? rate.primary],
        ['secondary', rate.secondary_window ?? rate.secondary]]) {
        if (!value || typeof value !== 'object')
            continue;
        const used = numeric(value.used_percent) ??
            (numeric(value.remaining_percent) !== null ? 100 - value.remaining_percent : null);
        if (used === null)
            continue;
        const minutes = numeric(value.window_minutes) ??
            (numeric(value.limit_window_seconds) ? Math.ceil(value.limit_window_seconds / 60) : 0);
        windows.push({key, label: windowLabel(minutes), usedPct: pct(used),
            resetAt: numeric(value.reset_at) ?? numeric(value.resets_at)});
    }
    // Duration identifies the weekly window regardless of its primary/secondary key.
    // Older responses omit duration; only then use the secondary window.
    const weekly = windows.find(w => w.label === '7d') ??
        windows.find(w => w.key === 'secondary' && w.label === 'window');
    return {
        status: 'ok', provider: 'codex', plan: payload.plan_type ?? root.plan_type ?? null,
        windows: weekly ? [{...weekly, key: 'weekly', label: 'Weekly'}] : [],
    };
}

export async function fetchCodex(session, {baseUrl = ''} = {}) {
    const auth = readCodexAuth();
    if (!auth)
        return {status: 'noauth', provider: 'codex', message: 'No Codex ChatGPT sign-in — run codex login'};
    if (auth.expired)
        return {status: 'auth', provider: 'codex', message: 'Codex token expired — sign in again with codex login'};
    let base = baseUrl.trim() || 'https://chatgpt.com/backend-api';
    base = base.replace(/\/+$/, '');
    if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)$/.test(base))
        base += '/backend-api';
    const url = base.includes('/backend-api') ? `${base}/wham/usage` : `${base}/api/codex/usage`;
    try {
        const headers = {Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/json',
            'User-Agent': 'codex-cli'};
        if (auth.accountId)
            headers['ChatGPT-Account-Id'] = auth.accountId;
        const res = await get(session, url, headers);
        if (res.status === 401 || res.status === 403)
            return {status: 'auth', provider: 'codex', message: `HTTP ${res.status} — sign in again with codex login`};
        if (res.status !== 200)
            return {status: 'error', provider: 'codex', message: `Usage endpoint returned HTTP ${res.status}`};
        return parseCodexUsage(JSON.parse(res.body));
    } catch (e) {
        return {status: 'error', provider: 'codex', message: `Usage request failed: ${e.message}`};
    }
}

// ---------------------------------------------------------------- OpenCode Go

export const OPENCODE_GO_ID = 'opencode-go';
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

// OpenCode 2 keeps credentials in its channel databases and imports the legacy
// auth.json once. Before that migration runs the file is still the source.
export const OPENCODE_CREDENTIAL_MIGRATION = '20260805200742_import_legacy_credentials';
const OPENCODE_DATABASES = ['opencode.db', 'opencode-next.db'];

export function opencodeDataDir() {
    const xdg = GLib.getenv('XDG_DATA_HOME');
    if (xdg)
        return GLib.build_filenamev([xdg, 'opencode']);
    return GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode']);
}

export function opencodeAuthPath(dataDir = opencodeDataDir()) {
    return GLib.build_filenamev([dataDir, 'auth.json']);
}

function isoSeconds(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : null;
    const ms = Date.parse(value ?? '');
    return Number.isFinite(ms) ? ms / 1000 : null;
}

// The OpenCode CLI is often installed outside the PATH the GNOME session
// inherited, so the well-known install locations are checked as well.
export function opencodeBinaries() {
    const home = GLib.get_home_dir();
    const candidates = [
        GLib.find_program_in_path('opencode'),
        GLib.build_filenamev([home, '.opencode', 'bin', 'opencode']),
        GLib.build_filenamev([home, '.local', 'bin', 'opencode']),
        GLib.build_filenamev([home, '.bun', 'bin', 'opencode']),
        '/usr/local/bin/opencode',
        '/usr/bin/opencode',
    ].filter(Boolean);
    return candidates.filter((path, index) =>
        GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE) && candidates.indexOf(path) === index);
}

// Runs a helper without blocking the GNOME Shell main loop.
function runProgramAsync(argv, timeoutSec = 10) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve(null);
            return;
        }
        let done = false;
        let timeoutId = 0;
        const finish = value => {
            if (done)
                return;
            done = true;
            if (timeoutId)
                GLib.source_remove(timeoutId);
            resolve(value);
        };
        timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSec, () => {
            try {
                proc.force_exit();
            } catch {
                /* the process is already gone */
            }
            finish(null);
            return GLib.SOURCE_REMOVE;
        });
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [ok, stdout] = p.communicate_utf8_finish(res);
                finish(ok ? stdout : null);
            } catch {
                finish(null);
            }
        });
    });
}

// `opencode auth export` prints the stored credentials, secrets included, as
// JSON. Only the opencode-go entry is read and nothing else is logged.
export function parseOpencodeExport(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }
    const entries = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object')
            continue;
        const id = entry.integrationID ?? entry.integration_id ?? entry.providerID ?? entry.provider;
        if (id !== OPENCODE_GO_ID)
            continue;
        const value = entry.value ?? entry.credential ?? entry;
        const key = typeof value === 'string' ? value : value?.key;
        if (typeof key === 'string' && key.trim())
            return key.trim();
    }
    return null;
}

export async function readOpencodeGoKeyFromCli() {
    for (const bin of opencodeBinaries()) {
        const out = await runProgramAsync([bin, 'auth', 'export', OPENCODE_GO_ID]);
        if (out === null)
            continue;
        const key = parseOpencodeExport(out);
        if (key)
            return key;
    }
    return null;
}

// The legacy file OpenCode 1 kept its API keys in.
export function readOpencodeGoKeyFromAuthFile(path = opencodeAuthPath()) {
    const entry = readAuthFile(path)[OPENCODE_GO_ID];
    const key = typeof entry === 'string' ? entry : entry?.key;
    return typeof key === 'string' && key.trim() ? key.trim() : null;
}

// OpenCode 2 stores the key in the credential table of its channel database.
async function readOpencodeCredentialState(path) {
    const python = GLib.find_program_in_path('python3');
    if (!python)
        return null;
    const script = [
        'import json, sqlite3, sys',
        'try:',
        '    db = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True)',
        '    migrated = db.execute(',
        '        "SELECT 1 FROM migration WHERE id = ? LIMIT 1", (sys.argv[2],)).fetchone() is not None',
        '    row = db.execute(',
        '        "SELECT value FROM credential WHERE integration_id = ? AND (active IS NULL OR active = 1)"',
        '        " ORDER BY active DESC, time_updated DESC, id DESC LIMIT 1", (sys.argv[3],)).fetchone()',
        '    print(json.dumps({"migrated": migrated, "value": row[0] if row else None}))',
        'except Exception:',
        '    print(json.dumps({"error": True}))',
    ].join('\n');
    const out = await runProgramAsync([python, '-c', script, path,
        OPENCODE_CREDENTIAL_MIGRATION, OPENCODE_GO_ID]);
    if (out === null)
        return null;
    try {
        const state = JSON.parse(out);
        return state && !state.error ? state : null;
    } catch {
        return null;
    }
}

// Returns the key plus whether a database owns the credential. A database that
// owns it and holds no key means the user logged out, so the legacy file must
// not resurrect the stale import.
export async function readOpencodeGoKeyFromDatabase(dataDir = opencodeDataDir()) {
    let authoritative = false;
    for (const name of OPENCODE_DATABASES) {
        const path = GLib.build_filenamev([dataDir, name]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;
        const state = await readOpencodeCredentialState(path);
        if (!state || !state.migrated)
            continue;
        authoritative = true;
        let value = null;
        try {
            value = state.value ? JSON.parse(state.value) : null;
        } catch {
            value = null;
        }
        const key = typeof value === 'string' ? value : value?.key;
        if (typeof key === 'string' && key.trim())
            return {key: key.trim(), authoritative: true};
    }
    return {key: null, authoritative};
}

export async function readOpencodeGoKey() {
    const cli = await readOpencodeGoKeyFromCli();
    if (cli)
        return cli;
    const db = await readOpencodeGoKeyFromDatabase();
    if (db.key)
        return db.key;
    if (!db.authoritative)
        return readOpencodeGoKeyFromAuthFile();
    return null;
}

// The Go usage endpoint reports three windows: the rolling 5-hour session, the
// weekly window and the monthly window. Every percent is the share of that
// window's allowance already spent.
export function parseOpencodeGoUsage(payload) {
    const usage = payload?.usage;
    if (!usage || typeof usage !== 'object')
        return null;
    const windows = [];
    for (const [key, label] of [['rolling', '5-hour'], ['weekly', 'Weekly'], ['monthly', 'Monthly']]) {
        const window = usage[key];
        if (!window || typeof window !== 'object')
            continue;
        const used = numeric(window.percent);
        if (used === null)
            continue;
        windows.push({key, label, usedPct: pct(used), resetAt: isoSeconds(window.resetsAt)});
    }
    return windows;
}

export async function fetchOpencodeGo(session) {
    let key;
    try {
        key = await readOpencodeGoKey();
    } catch (e) {
        return {status: 'error', provider: 'opencode-go',
            message: `Could not read the OpenCode Go key: ${e.message}`};
    }
    if (!key)
        return {status: 'noauth', provider: 'opencode-go',
            message: 'No OpenCode Go sign-in — run /connect in OpenCode and pick OpenCode Go'};
    try {
        const res = await get(session, OPENCODE_GO_USAGE_URL, {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'User-Agent': 'openusage-gnome/1.0',
        });
        if (res.status === 401)
            return {status: 'auth', provider: 'opencode-go',
                message: 'OpenCode Go key rejected — sign in again with /connect'};
        if (res.status === 403)
            return {status: 'auth', provider: 'opencode-go',
                message: 'No OpenCode Go subscription on this key'};
        if (res.status !== 200)
            return {status: 'error', provider: 'opencode-go',
                message: `Usage endpoint returned HTTP ${res.status}`};
        const windows = parseOpencodeGoUsage(JSON.parse(res.body));
        if (!windows || !windows.length)
            return {status: 'error', provider: 'opencode-go',
                message: 'Usage response did not report any window'};
        return {status: 'ok', provider: 'opencode-go', plan: null, windows};
    } catch (e) {
        return {status: 'error', provider: 'opencode-go',
            message: `Usage request failed: ${e.message}`};
    }
}
