// ChatGPT weekly usage from the Codex CLI sign-in, Grok Build from the
// grok CLI sign-in, and Grok Bot from the desktop app's saved session.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import Secret from 'gi://Secret';

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
        windows: weekly ? [{...weekly, label: 'Weekly'}] : [],
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

export function grokHome() {
    return GLib.getenv('GROK_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.grok']);
}

export function grokAuthPath() {
    return GLib.build_filenamev([grokHome(), 'auth.json']);
}

function readGrokVersion() {
    try {
        const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([grokHome(), 'version.json']));
        const version = ok ? JSON.parse(decoder.decode(bytes)).version : null;
        return typeof version === 'string' && version.trim() ? version.trim() : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

// Newest Grok CLI OIDC session. The extension does not refresh or write it.
export function readGrokAuth(auth = readAuthFile(grokAuthPath())) {
    const entries = Object.values(auth).filter(entry =>
        entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim());
    if (!entries.length)
        return null;
    entries.sort((a, b) => String(b.expires_at ?? '').localeCompare(String(a.expires_at ?? '')));
    const entry = entries[0];
    const expiresAt = Date.parse(entry.expires_at);
    return {
        accessToken: entry.key.trim(),
        expired: Number.isFinite(expiresAt) && expiresAt <= Date.now(),
        version: readGrokVersion(),
    };
}

function isoSeconds(value) {
    const ms = Date.parse(value ?? '');
    return Number.isFinite(ms) ? ms / 1000 : null;
}

function usageWindow(used, resetAt) {
    if (used === null)
        return [];
    return [{key: 'weekly', label: 'Weekly', usedPct: pct(used), resetAt}];
}

// creditUsagePercent is the shared weekly pool Grok Build's /usage screen shows.
// productUsage entries are shares of that pool, not separate allowances.
export function parseGrokCredits(payload) {
    const config = payload?.config && typeof payload.config === 'object' ? payload.config : payload ?? {};
    return {
        usedPct: numeric(config.creditUsagePercent),
        resetAt: isoSeconds(config.currentPeriod?.end ?? config.billingPeriodEnd),
    };
}

function readVarint(bytes, offset) {
    let value = 0;
    let shift = 0;
    let i = offset;
    while (i < bytes.length && shift <= 28) {
        const byte = bytes[i++];
        value += (byte & 0x7f) * (2 ** shift);
        if ((byte & 0x80) === 0)
            return [value, i];
        shift += 7;
    }
    return [null, bytes.length];
}

function protobufFields(bytes) {
    const fields = [];
    let i = 0;
    while (i < bytes.length) {
        const [key, next] = readVarint(bytes, i);
        if (key === null)
            break;
        i = next;
        const id = key >> 3;
        const wire = key & 7;
        if (wire === 0) {
            const [value, after] = readVarint(bytes, i);
            if (value === null)
                break;
            fields.push({id, value});
            i = after;
        } else if (wire === 5 && i + 4 <= bytes.length) {
            const value = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getFloat32(0, true);
            fields.push({id, value});
            i += 4;
        } else if (wire === 1 && i + 8 <= bytes.length) {
            i += 8;
        } else if (wire === 2) {
            const [length, after] = readVarint(bytes, i);
            if (length === null || after + length > bytes.length)
                break;
            fields.push({id, bytes: bytes.slice(after, after + length)});
            i = after + length;
        } else {
            break;
        }
    }
    return fields;
}

function timestampSeconds(message) {
    const seconds = protobufFields(message).find(field => field.id === 1 && typeof field.value === 'number');
    return seconds ? seconds.value : null;
}

// GetGrokCreditsConfig, the endpoint Grok Build uses when the REST payload
// omits a zero. Field 1 is the used percent; an active period with no field
// is 0% used. Field 5 is the period end.
export function parseGrokCreditsFrame(input) {
    const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
    let message = bytes;
    if (bytes.length >= 5 && (bytes[0] === 0 || bytes[0] === 1)) {
        const length = new DataView(bytes.buffer, bytes.byteOffset, 5).getUint32(1);
        if (5 + length <= bytes.length)
            message = bytes.slice(5, 5 + length);
    }
    const top = protobufFields(message);
    const config = top.find(field => field.id === 1 && field.bytes)?.bytes ?? message;
    const fields = protobufFields(config);
    const used = fields.find(field => field.id === 1 && typeof field.value === 'number');
    const resetAt = timestampSeconds(fields.find(field => field.id === 5 && field.bytes)?.bytes ?? new Uint8Array());
    const start = timestampSeconds(fields.find(field => field.id === 4 && field.bytes)?.bytes ?? new Uint8Array());
    const now = Date.now() / 1000;
    const periodActive = start !== null && resetAt !== null && start <= now && resetAt > now;
    return {
        usedPct: used ? used.value : (periodActive ? 0 : null),
        resetAt,
    };
}

export function grokBuildResult(credits, plan = null) {
    if (!credits || credits.usedPct === null) {
        return {status: 'ok', provider: 'grok-build', plan, windows: [],
            message: credits?.resetAt ? 'Weekly usage not reported yet' : 'Weekly usage unavailable'};
    }
    return {status: 'ok', provider: 'grok-build', plan, windows: usageWindow(credits.usedPct, credits.resetAt)};
}

function grokHeaders(auth) {
    return {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'x-grok-client-version': auth.version,
        'x-grok-client-surface': 'grok-build',
        'X-XAI-Token-Auth': 'xai-grok-cli',
        'User-Agent': `grok/${auth.version}`,
    };
}

export async function fetchGrokBuild(session) {
    const auth = readGrokAuth();
    if (!auth)
        return {status: 'noauth', provider: 'grok-build', message: 'No Grok CLI sign-in — run grok login'};
    if (auth.expired)
        return {status: 'auth', provider: 'grok-build', message: 'Grok CLI token expired — run grok login'};
    const base = (GLib.getenv('GROK_CLI_CHAT_PROXY_BASE_URL') || 'https://cli-chat-proxy.grok.com').replace(/\/+$/, '');
    try {
        const headers = grokHeaders(auth);
        const res = await get(session, `${base}/v1/billing?format=credits`, headers);
        if (res.status === 401 || res.status === 403)
            return {status: 'auth', provider: 'grok-build', message: `HTTP ${res.status} — run grok login`};
        if (res.status !== 200)
            return {status: 'error', provider: 'grok-build', message: `Usage endpoint returned HTTP ${res.status}`};
        let credits = parseGrokCredits(JSON.parse(res.body));
        if (credits.usedPct === null) {
            const frame = await request(session, 'POST',
                'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig',
                {...headers, 'Content-Type': 'application/grpc-web+proto', 'x-grpc-web': '1',
                    Origin: 'https://grok.com'},
                Uint8Array.from([0, 0, 0, 0, 2, 8, 0]), 'application/grpc-web+proto');
            if (frame.status === 200)
                credits = {...parseGrokCreditsFrame(frame.raw), resetAt: credits.resetAt ?? parseGrokCreditsFrame(frame.raw).resetAt};
        }
        let plan = null;
        try {
            const settings = await get(session, `${base}/v1/settings`, headers);
            if (settings.status === 200) {
                const tier = JSON.parse(settings.body).subscription_tier_display;
                plan = typeof tier === 'string' ? tier : null;
            }
        } catch {
            plan = null;
        }
        return grokBuildResult(credits, plan);
    } catch (e) {
        return {status: 'error', provider: 'grok-build', message: `Usage request failed: ${e.message}`};
    }
}

function grokBotSecretsPath() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'Grok Bot', 'sand-secrets.json']);
}

function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function openssl(args) {
    const bin = GLib.find_program_in_path('openssl') || '/usr/bin/openssl';
    const [ok, stdout, stderr, status] = GLib.spawn_sync(null, [bin, ...args], null,
        GLib.SpawnFlags.SEARCH_PATH, null);
    if (!ok || !GLib.spawn_check_exit_status(status))
        throw new Error(decoder.decode(stderr).trim() || 'openssl failed');
    return stdout;
}

// Chromium v11 safeStorage: PBKDF2-HMAC-SHA1("saltysalt", 1) and AES-128-CBC.
function decryptSafeStorage(password, blob) {
    const prefix = decoder.decode(blob.slice(0, 3));
    const secret = prefix === 'v10' ? 'peanuts' : password;
    if (prefix !== 'v10' && prefix !== 'v11')
        return null;
    if (!secret)
        return null;
    const key = openssl(['kdf', '-keylen', '16', '-binary', '-kdfopt', 'digest:SHA1',
        '-kdfopt', `hexpass:${hex(new TextEncoder().encode(secret))}`,
        '-kdfopt', `hexsalt:${hex(new TextEncoder().encode('saltysalt'))}`,
        '-kdfopt', 'iter:1', 'PBKDF2']);
    const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `openusage-${GLib.random_int()}`]);
    try {
        Gio.File.new_for_path(tmp).replace_contents(blob.slice(3), null, false, Gio.FileCreateFlags.PRIVATE, null);
        const plain = openssl(['enc', '-aes-128-cbc', '-d', '-nopad', '-K', hex(key),
            '-iv', '20'.repeat(16), '-in', tmp]);
        const pad = plain[plain.length - 1];
        const unpadded = pad >= 1 && pad <= 16 ? plain.slice(0, plain.length - pad) : plain;
        const text = decoder.decode(unpadded);
        return text.startsWith('eyJ') ? text : null;
    } finally {
        GLib.unlink(tmp);
    }
}

export function readGrokBotToken(secrets = readAuthFile(grokBotSecretsPath()), password = null) {
    let accounts = secrets['cursor-accounts'];
    if (typeof accounts === 'string') {
        try {
            accounts = JSON.parse(accounts);
        } catch {
            return null;
        }
    }
    const active = accounts?.accounts?.[accounts?.active];
    const stored = active?.['cursor-access-token'];
    if (typeof stored !== 'string' || !stored.trim())
        return null;
    if (stored.startsWith('eyJ'))
        return {accessToken: stored, expired: false};
    let blob;
    try {
        blob = GLib.base64_decode(stored);
    } catch {
        return null;
    }
    const accessToken = decryptSafeStorage(password, blob);
    if (!accessToken)
        return null;
    let expired = false;
    try {
        const part = accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(decoder.decode(GLib.base64_decode(part + '='.repeat((4 - part.length % 4) % 4))));
        expired = typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now();
    } catch {
        expired = false;
    }
    return {accessToken, expired};
}

function lookupGrokBotPassword() {
    const schema = new Secret.Schema('chrome_libsecret_os_crypt_password_v2',
        Secret.SchemaFlags.NONE, {application: Secret.SchemaAttributeType.STRING});
    return Secret.password_lookup_sync(schema, {application: 'Grok Bot'}, null);
}

export function parseGrokBotUsage(payload) {
    if (payload?.hasNonZeroIncludedLimit === false) {
        return {status: 'ok', provider: 'grok-bot', plan: payload.grokPlanLabel ?? null, windows: [],
            message: 'No included Grok Bot allowance'};
    }
    const used = numeric(payload?.usagePercent);
    return {
        status: 'ok', provider: 'grok-bot', plan: typeof payload?.grokPlanLabel === 'string' ? payload.grokPlanLabel : null,
        windows: usageWindow(used, isoSeconds(payload?.nextResetTimestampUtc)),
        message: used === null ? 'Weekly usage unavailable' : null,
    };
}

export async function fetchGrokBot(session) {
    const secrets = readAuthFile(grokBotSecretsPath());
    if (!secrets['cursor-accounts'])
        return {status: 'noauth', provider: 'grok-bot', message: 'No Grok Bot sign-in'};
    let auth;
    try {
        auth = readGrokBotToken(secrets, lookupGrokBotPassword());
    } catch (e) {
        return {status: 'error', provider: 'grok-bot', message: `Could not read the Grok Bot session: ${e.message}`};
    }
    if (!auth)
        return {status: 'error', provider: 'grok-bot', message: 'Could not read the Grok Bot session'};
    if (auth.expired)
        return {status: 'auth', provider: 'grok-bot', message: 'Grok Bot session expired — sign in again'};
    try {
        const res = await request(session, 'POST',
            'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus',
            {Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1', Accept: 'application/json'},
            new TextEncoder().encode('{}'), 'application/json');
        if (res.status === 401 || res.status === 403)
            return {status: 'auth', provider: 'grok-bot', message: `HTTP ${res.status} — sign in to Grok Bot again`};
        if (res.status !== 200)
            return {status: 'error', provider: 'grok-bot', message: `Usage endpoint returned HTTP ${res.status}`};
        return parseGrokBotUsage(JSON.parse(res.body));
    } catch (e) {
        return {status: 'error', provider: 'grok-bot', message: `Usage request failed: ${e.message}`};
    }
}
