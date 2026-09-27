// Usage data for pi's OpenAI Codex and OpenCode Go accounts only.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const decoder = new TextDecoder();
const pct = v => Math.max(0, Math.min(100, v));
const numeric = v => typeof v === 'number' && Number.isFinite(v) ? v : null;

export function mkSession(timeoutSec = 15) {
    return new Soup.Session({timeout: timeoutSec, user_agent: 'openusage-gnome/1.0'});
}

async function get(session, url, headers) {
    const msg = Soup.Message.new('GET', url);
    for (const [name, value] of Object.entries(headers))
        msg.get_request_headers().append(name, value);
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, result) => {
            try {
                const bytes = s.send_and_read_finish(result);
                resolve({status: msg.status_code, body: decoder.decode(bytes.get_data())});
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function piAuthPath() {
    const dir = GLib.getenv('PI_CODING_AGENT_DIR') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.pi', 'agent']);
    return GLib.build_filenamev([dir, 'auth.json']);
}

export function readPiAuth(path = piAuthPath()) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        const data = ok ? JSON.parse(decoder.decode(bytes)) : null;
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

// Named entries only: never use or display Claude/Anthropic credentials.
export function readCodexAuth(auth = readPiAuth()) {
    const entry = auth['openai-codex'];
    if (entry?.type !== 'oauth' || typeof entry.access !== 'string' || !entry.access)
        return null;
    return {
        accessToken: entry.access,
        accountId: typeof entry.accountId === 'string' ? entry.accountId : null,
        expired: typeof entry.expires === 'number' && entry.expires <= Date.now(),
    };
}

export function readOpenCodeKeys(auth = readPiAuth()) {
    const entry = auth['opencode-go'];
    return {go: entry?.type === 'api_key' && typeof entry.key === 'string' && entry.key.trim()
        ? entry.key.trim() : null};
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
    const extras = [];
    for (const extra of root.additional_rate_limits ?? payload.additional_rate_limits ?? []) {
        const name = extra.limit_name ?? extra.metered_feature;
        if (typeof name !== 'string' || name === 'codex')
            continue;
        const limit = extra.rate_limit ?? {};
        const parsed = parseCodexUsage({rate_limit: limit}).windows;
        if (parsed.length)
            extras.push({name, windows: parsed});
    }
    const credits = root.credits ?? payload.credits;
    return {
        status: 'ok', provider: 'codex', plan: payload.plan_type ?? root.plan_type ?? null,
        windows, extras,
        credits: credits ? {
            hasCredits: !!(credits.has_credits || credits.hasCredits),
            unlimited: !!credits.unlimited,
            balance: numeric(credits.balance) ?? (Number.isFinite(Number(credits.balance)) ? Number(credits.balance) : null),
        } : null,
        maxPct: Math.max(0, ...windows.map(w => w.usedPct),
            ...extras.flatMap(e => e.windows.map(w => w.usedPct))),
    };
}

export async function fetchCodex(session, {baseUrl = ''} = {}) {
    const auth = readCodexAuth();
    if (!auth)
        return {status: 'noauth', provider: 'codex', message: 'No pi OpenAI Codex account — sign in with pi'};
    if (auth.expired)
        return {status: 'auth', provider: 'codex', message: 'Pi Codex token expired — re-authenticate in pi'};
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
            return {status: 'auth', provider: 'codex', message: `HTTP ${res.status} — re-authenticate in pi`};
        if (res.status !== 200)
            return {status: 'error', provider: 'codex', message: `Usage endpoint returned HTTP ${res.status}`};
        return parseCodexUsage(JSON.parse(res.body));
    } catch (e) {
        return {status: 'error', provider: 'codex', message: `Usage request failed: ${e.message}`};
    }
}

export function parseGoUsage(payload) {
    const labels = {rolling: 'rolling (5h)', weekly: 'weekly', monthly: 'monthly'};
    const usage = Object.entries(payload?.usage ?? {})
        .filter(([, value]) => value && typeof value === 'object' && numeric(value.percent) !== null)
        .map(([key, value]) => ({key, label: labels[key] ?? key, pct: pct(value.percent),
            resetAt: typeof value.resetsAt === 'number' ? Math.floor(value.resetsAt / (value.resetsAt > 1e12 ? 1000 : 1)) :
                (typeof value.resetsAt === 'string' && Number.isFinite(Date.parse(value.resetsAt)) ?
                    Math.floor(Date.parse(value.resetsAt) / 1000) : null)}));
    return {status: 'ok', provider: 'opencode', usage,
        maxPct: usage.length ? Math.max(...usage.map(w => w.pct)) : null};
}

export async function fetchOpenCode(session) {
    const key = readOpenCodeKeys().go;
    if (!key)
        return {status: 'noauth', provider: 'opencode', message: 'No pi OpenCode Go account — sign in with pi'};
    try {
        const res = await get(session, 'https://opencode.ai/zen/go/v1/usage', {
            Authorization: `Bearer ${key}`, Accept: 'application/json',
        });
        if (res.status === 401 || res.status === 403)
            return {status: 'auth', provider: 'opencode', message: `HTTP ${res.status} — check pi OpenCode Go key`};
        if (res.status === 429)
            return {status: 'limited', provider: 'opencode', message: 'Rate limited (HTTP 429)'};
        if (res.status !== 200)
            return {status: 'error', provider: 'opencode', message: `Usage endpoint returned HTTP ${res.status}`};
        return parseGoUsage(JSON.parse(res.body));
    } catch (e) {
        return {status: 'error', provider: 'opencode', message: `Usage request failed: ${e.message}`};
    }
}
