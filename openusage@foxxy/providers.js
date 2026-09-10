// providers.js — usage data layer for OpenUsage@foxxy
// Ported (a.k.a. shamelessly stolen) from janekbaraniewski/openusage (Go):
//   internal/providers/codex/live_usage.go
//   internal/providers/zai/{zai.go,monitor_helpers.go,usage_extract.go,usage_helpers.go}
//   internal/providers/opencode/{provider.go,console_rpc.go,seroval.go}
// Framework-free so it can run under `gjs -m` for testing.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const DECODER = new TextDecoder();

// ---------------------------------------------------------------- utilities

export function mkSession(timeoutSec = 15) {
    return new Soup.Session({ timeout: timeoutSec, user_agent: 'openusage-gnome/1.0' });
}

export function httpGet(session, url, headers = {}, { noRedirect = false } = {}) {
    return new Promise((resolve, reject) => {
        let msg;
        try {
            msg = Soup.Message.new('GET', url);
        } catch (e) {
            reject(new Error(`bad url: ${url}`));
            return;
        }
        const reqHeaders = msg.get_request_headers();
        for (const [name, value] of Object.entries(headers))
            reqHeaders.append(name, value);
        if (noRedirect)
            msg.set_flags(Soup.MessageFlags.NO_REDIRECT);

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            try {
                const bytes = sess.send_and_read_finish(result);
                const status = msg.status_code;
                const body = bytes ? DECODER.decode(bytes.get_data()) : '';
                const loc = msg.response_headers.get_one('Location');
                resolve({ status, body, location: loc ?? null, uri: msg.uri.to_string() });
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function readJsonFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return JSON.parse(DECODER.decode(bytes));
    } catch {
        return null;
    }
}

const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
const firstNum = (obj, ...keys) => {
    for (const k of keys) {
        const v = num(obj?.[k]);
        if (v !== null)
            return v;
    }
    return null;
};
const firstStr = (obj, ...keys) => {
    for (const k of keys) {
        const v = obj?.[k];
        if (typeof v === 'string' && v.trim() !== '')
            return v.trim();
    }
    return null;
};
const clampPct = (v) => Math.max(0, Math.min(100, v));

function windowLabel(minutes) {
    if (!minutes || minutes <= 0)
        return 'window';
    if (minutes % (60 * 24 * 30) === 0 && minutes >= 60 * 24 * 30)
        return `${minutes / (60 * 24 * 30)}mo`;
    if (minutes % (60 * 24) === 0)
        return `${minutes / (60 * 24)}d`;
    if (minutes % 60 === 0)
        return `${minutes / 60}h`;
    return `${minutes}m`;
}

function parseResetTime(v) {
    if (v == null)
        return null;
    if (typeof v === 'number') {
        // epoch seconds vs. milliseconds heuristic
        const sec = v > 1e12 ? Math.floor(v / 1000) : v;
        return sec > 1e9 ? sec : null;
    }
    if (typeof v === 'string') {
        const t = Date.parse(v.includes('T') || v.includes('Z') ? v : v.replace(' ', 'T') + 'Z');
        return isFinite(t) ? Math.floor(t / 1000) : null;
    }
    return null;
}

// ------------------------------------------------------------------- Codex
// GET https://chatgpt.com/backend-api/wham/usage
//   Authorization: Bearer <auth.json tokens.access_token>
//   ChatGPT-Account-Id: <account_id>   User-Agent: codex-cli

export function readCodexAuth() {
    const path = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'auth.json']);
    const auth = readJsonFile(path);
    if (!auth)
        return null;
    const accessToken = auth?.tokens?.access_token ?? null;
    const accountId = auth?.tokens?.account_id ?? auth?.account_id ?? null;
    return accessToken ? { accessToken, accountId } : null;
}

export async function fetchCodex(session, { baseUrl = '' } = {}) {
    const auth = readCodexAuth();
    if (!auth)
        return { status: 'noauth', provider: 'codex', message: 'No ~/.codex/auth.json — run Codex CLI once to sign in' };

    let base = (baseUrl || '').trim() || 'https://chatgpt.com/backend-api';
    base = base.replace(/\/+$/, '');
    if ((base.startsWith('https://chatgpt.com') || base.startsWith('https://chat.openai.com')) && !base.includes('/backend-api'))
        base += '/backend-api';
    const url = base.includes('/backend-api') ? `${base}/wham/usage` : `${base}/api/codex/usage`;

    const headers = {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'codex-cli',
    };
    if (auth.accountId)
        headers['ChatGPT-Account-Id'] = auth.accountId;

    let res;
    try {
        res = await httpGet(session, url, headers);
    } catch (e) {
        return { status: 'error', provider: 'codex', message: `network: ${e.message}` };
    }
    if (res.status === 401 || res.status === 403)
        return { status: 'auth', provider: 'codex', message: `HTTP ${res.status} — token expired, re-login Codex CLI` };
    if (res.status !== 200)
        return { status: 'error', provider: 'codex', message: `HTTP ${res.status} from ${url}` };

    let payload;
    try {
        payload = JSON.parse(res.body);
    } catch {
        return { status: 'error', provider: 'codex', message: 'invalid JSON from ChatGPT usage endpoint' };
    }

    const planType = firstStr(payload, 'plan_type') ?? firstStr(payload.rate_limit_status, 'plan_type');
    const statusSrc = payload.rate_limit_status ?? payload;

    // primary/secondary windows, both naming conventions (openusage parity)
    const rl = statusSrc.rate_limit ?? payload.rate_limit ?? {};
    const windows = [];
    const grabWindow = (w, key) => {
        if (!w || typeof w !== 'object')
            return;
        let used = firstNum(w, 'used_percent');
        if (used === null) {
            const rem = firstNum(w, 'remaining_percent');
            if (rem !== null)
                used = 100 - rem;
        }
        if (used === null)
            return;
        let minutes = num(w.window_minutes) ?? 0;
        if (!minutes && num(w.limit_window_seconds))
            minutes = Math.ceil(w.limit_window_seconds / 60);
        const resetAt = firstNum(w, 'reset_at', 'resets_at');
        windows.push({
            key,
            label: windowLabel(minutes),
            usedPct: clampPct(used),
            resetAt: resetAt ?? null,
        });
    };
    grabWindow(rl.primary_window ?? rl.primary, 'primary');
    grabWindow(rl.secondary_window ?? rl.secondary, 'secondary');

    // extra metered features (e.g. gpt-reserve)
    const extras = [];
    for (const extra of statusSrc.additional_rate_limits ?? payload.additional_rate_limits ?? []) {
        const name = firstStr(extra, 'limit_name', 'metered_feature');
        if (!name || name === 'codex')
            continue;
        const ex = extra.rate_limit ?? {};
        const sub = [];
        grabWindow(ex.primary_window ?? ex.primary, `${name}-primary`);
        grabWindow(ex.secondary_window ?? ex.secondary, `${name}-secondary`);
        // grabWindow pushes onto `windows`; move the two just added into extras
        while (windows.length && windows[windows.length - 1].key.startsWith(name))
            sub.unshift(windows.pop());
        if (sub.length)
            extras.push({ name, windows: sub });
    }

    const credits = statusSrc.credits ?? payload.credits ?? null;
    let creditsInfo = null;
    if (credits) {
        creditsInfo = {
            hasCredits: !!(credits.has_credits || credits.hasCredits),
            unlimited: !!credits.unlimited,
            balance: num(credits.balance) ?? (typeof credits.balance === 'string' && credits.balance !== '' && isFinite(+credits.balance) ? +credits.balance : null),
        };
    }

    const maxPct = windows.reduce((m, w) => Math.max(m, w.usedPct), 0);
    return {
        status: 'ok',
        provider: 'codex',
        plan: planType,
        email: firstStr(payload, 'email'),
        windows,
        extras,
        credits: creditsInfo,
        maxPct,
    };
}

// -------------------------------------------------------------------- Z.AI
// monitor endpoints:  Authorization: <key>  (raw first, then "Bearer " retry)
//   GET <monitor>/api/monitor/usage/quota/limit   → 5h tokens % + monthly
//   GET <monitor>/api/paas/v4/user/credit_grants  → credits
//   GET <coding>/api/coding/paas/v4/models        → model catalog

function extractLimitRows(v) {
    if (Array.isArray(v))
        return v.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (v && typeof v === 'object') {
        if ('type' in v)
            return [v];
        for (const key of ['limits', 'items', 'data']) {
            if (key in v) {
                const rows = extractLimitRows(v[key]);
                if (rows.length)
                    return rows;
            }
        }
        let all = [];
        for (const nested of Object.values(v))
            all = all.concat(extractLimitRows(nested));
        return all;
    }
    return [];
}

async function zaiGet(session, url, key) {
    let res = await httpGet(session, url, {
        Authorization: key,
        'Accept-Language': 'en-US,en',
        'Content-Type': 'application/json',
    });
    if (res.status === 401 || res.status === 403)
        res = await httpGet(session, url, {
            Authorization: `Bearer ${key}`,
            'Accept-Language': 'en-US,en',
            'Content-Type': 'application/json',
        });
    return res;
}

export async function fetchZai(session, { apiKey, region = 'global' } = {}) {
    let key = (apiKey || '').trim();
    if (!key)
        key = (GLib.getenv('ZAI_API_KEY') || GLib.getenv('ZHIPUAI_API_KEY') || '').trim();
    if (!key) {
        // single-source-of-truth file: ~/.config/zai (user convention)
        try {
            const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([GLib.get_home_dir(), '.config', 'zai']));
            if (ok)
                key = DECODER.decode(bytes).trim();
        } catch {
            /* no file */
        }
    }
    if (!key)
        return {
            status: 'noauth',
            provider: 'zai',
            message: 'No Z.AI API key — set it in OpenUsage settings (or $ZAI_API_KEY)',
        };

    const monitor = region === 'china' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
    const coding = `${monitor}/api/coding/paas/v4`;

    // -- quota/limit --------------------------------------------------------
    let res;
    try {
        res = await zaiGet(session, `${monitor}/api/monitor/usage/quota/limit`, key);
    } catch (e) {
        return { status: 'error', provider: 'zai', message: `network: ${e.message}` };
    }
    if (res.status === 401 || res.status === 403)
        return { status: 'auth', provider: 'zai', message: `HTTP ${res.status} — check Z.AI API key` };
    if (res.status === 429)
        return { status: 'limited', provider: 'zai', message: 'rate limited (HTTP 429)' };
    if (res.status !== 200)
        return { status: 'error', provider: 'zai', message: `HTTP ${res.status} from quota/limit` };

    let envelope;
    try {
        envelope = JSON.parse(res.body);
    } catch {
        return { status: 'error', provider: 'zai', message: 'invalid JSON from quota/limit' };
    }

    const data = envelope?.data ?? null;
    const rows = data ? extractLimitRows(data) : [];
    let fiveHour = null;
    let monthly = null;
    const creditWindows = [];
    // unit code → suffix (observed: 3=hours, 6=weeks on GLM coding plans)
    const unitSuffix = {1: 'm', 2: 'h', 3: 'h', 4: 'd', 5: 'w', 6: 'w'};
    for (const row of rows) {
        const kind = (firstStr(row, 'type', 'limitType') ?? '').toUpperCase();
        let pct = firstNum(row, 'percentage', 'usedPercent', 'used_percentage');
        if (kind === 'CREDIT_LIMIT') {
            // new coding-plan format: integer percentages — no ≤1 scaling
        } else if (pct !== null && pct <= 1) {
            pct *= 100;
        }
        if (kind === 'CREDIT_LIMIT') {
            // new coding-plan format: {type, unit, number, usage, currentValue,
            // remaining, percentage, nextResetTime(ms)} — usage/quota are credits
            const n = num(row.number) ?? 1;
            const label = `${n}${unitSuffix[num(row.unit)] ?? '?'}`;
            const win = {
                label,
                pct: pct !== null ? clampPct(pct) : null,
                used: firstNum(row, 'currentValue', 'current', 'used'),
                limit: firstNum(row, 'usage', 'limit', 'quota'),
                remaining: num(row.remaining),
                resetAt: parseResetTime(row.nextResetTime ?? row.resetTime ?? row.reset_at),
            };
            creditWindows.push(win);
            if (win.label === '5h' || (win.label.endsWith('h') && !fiveHour)) {
                fiveHour = {
                    pct: win.pct,
                    tokens: win.used != null && win.limit != null ? {used: win.used, limit: win.limit, remaining: win.remaining ?? Math.max(win.limit - win.used, 0)} : undefined,
                    resetAt: win.resetAt,
                };
            } else if (!monthly) {
                monthly = {pct: win.pct ?? (win.used != null && win.limit ? clampPct((win.used / win.limit) * 100) : 0), used: win.used, limit: win.limit};
            }
            continue;
        }
        if (kind === 'TOKENS_LIMIT') {
            fiveHour = { pct: pct !== null ? clampPct(pct) : null };
            const used = firstNum(row, 'currentValue', 'current', 'used');
            const limit = firstNum(row, 'usage', 'limit', 'quota');
            if (used !== null && limit !== null)
                fiveHour.tokens = { used, limit, remaining: Math.max(limit - used, 0) };
            fiveHour.resetAt = parseResetTime(row.nextResetTime ?? row.resetTime ?? row.reset_at);
        } else if (kind === 'TIME_LIMIT') {
            const used = firstNum(row, 'currentValue', 'current', 'used');
            const limit = firstNum(row, 'usage', 'limit', 'quota');
            if (used !== null && limit !== null)
                monthly = { pct: pct !== null ? clampPct(pct) : clampPct((used / limit) * 100), used, limit };
            else if (pct !== null)
                monthly = { pct: clampPct(pct) };
        }
    }

    if (!fiveHour && !monthly && creditWindows.length === 0)
        return {
            status: 'warn',
            provider: 'zai',
            message: 'Connected, but no active coding package',
        };

    // -- credits (best effort) ---------------------------------------------
    let credits = null;
    try {
        const cRes = await zaiGet(session, `${monitor}/api/paas/v4/user/credit_grants`, key);
        if (cRes.status === 200) {
            const c = JSON.parse(cRes.body);
            const root = c && typeof c === 'object' ? c : {};
            const inner = root.data && typeof root.data === 'object' ? root.data : {};
            const avail = firstNum(root, 'total_available', 'totalAvailable', 'remaining_balance', 'available', 'balance', 'remaining') ??
                firstNum(inner, 'total_available', 'totalAvailable', 'remaining_balance', 'available', 'balance', 'remaining');
            const usedC = firstNum(root, 'total_used', 'totalUsed', 'usage', 'spent', 'used') ??
                firstNum(inner, 'total_used', 'totalUsed', 'usage', 'spent', 'used');
            const limit = firstNum(root, 'total_granted', 'totalGranted', 'total_credits', 'credit_limit', 'limit') ??
                firstNum(inner, 'total_granted', 'totalGranted', 'total_credits', 'credit_limit', 'limit');
            if (avail !== null || usedC !== null || limit !== null)
                credits = { available: avail, used: usedC, limit };
        }
    } catch {
        /* non-fatal */
    }

    // -- model catalog (best effort) ----------------------------------------
    let models = null;
    try {
        const mRes = await zaiGet(session, `${coding}/models`, key);
        if (mRes.status === 200) {
            const m = JSON.parse(mRes.body);
            if (Array.isArray(m?.data))
                models = m.data.map((x) => x?.id).filter((x) => typeof x === 'string');
        }
    } catch {
        /* non-fatal */
    }

    const maxPct = Math.max(
        fiveHour?.pct ?? 0,
        monthly?.pct ?? 0,
        ...creditWindows.map((w) => w.pct ?? 0));
    return {
        status: 'ok',
        provider: 'zai',
        planLevel: firstStr(data ?? {}, 'level'),
        fiveHour,
        monthly,
        creditWindows,
        credits,
        models,
        maxPct,
    };
}

// ------------------------------------------------------------ Antigravity
// agy statusline hook contract: agy pipes status JSON into the configured
// statusLine.command; our hook tees it to $XDG_STATE_HOME/openusage/
// antigravity-status.json and we read that. Ported from openusage's
// internal/providers/antigravity (statusline.go).

export function antigravityStatusPath() {
    const override = GLib.getenv('OPENUSAGE_ANTIGRAVITY_STATUS_FILE');
    if (override)
        return override;
    const state = GLib.getenv('XDG_STATE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    return `${state}/openusage/antigravity-status.json`;
}

function prettyQuotaLabel(key) {
    return (key ?? 'quota').replace(/[_-]+/g, ' ').trim();
}

export async function fetchAntigravity() {
    const path = antigravityStatusPath();
    const payload = readJsonFile(path);
    if (!payload || typeof payload !== 'object')
        return {
            status: 'noauth',
            provider: 'antigravity',
            path,
            message: 'No status data yet — run `agy` (statusline hook feeds the meter)',
        };

    const quota = payload.quota && typeof payload.quota === 'object' ? payload.quota : {};
    const windows = [];
    for (const [key, q] of Object.entries(quota)) {
        let fraction = null;
        if (q && typeof q === 'object' && num(q.remaining_fraction) !== null)
            fraction = q.remaining_fraction;
        else if (num(q) !== null)
            fraction = q; // documented numeric-fraction shorthand
        if (fraction === null)
            continue;
        fraction = Math.max(0, Math.min(1, fraction));
        let resetAt = null;
        if (q && typeof q === 'object') {
            if (q.reset_time)
                resetAt = parseResetTime(q.reset_time);
            else if (num(q.reset_in_seconds) !== null)
                resetAt = Math.floor(Date.now() / 1000) + q.reset_in_seconds;
        }
        windows.push({key, label: prettyQuotaLabel(key), leftPct: fraction * 100, resetAt});
    }

    if (!windows.length)
        return {status: 'warn', provider: 'antigravity', path, message: 'Status payload has no quota data yet'};

    // staleness: agy only refreshes the file while it runs
    let stale = false;
    const received = payload.received_at ? Date.parse(payload.received_at) : NaN;
    if (isFinite(received) && Date.now() - received > 24 * 3600 * 1000)
        stale = true;

    const minLeft = Math.min(...windows.map((w) => w.leftPct));
    return {
        status: stale ? 'warn' : 'ok',
        provider: 'antigravity',
        path,
        windows,
        minLeft,
        maxPct: 100 - minLeft,
        stale,
        model: payload.model?.display_name ?? payload.model?.id ?? null,
        planTier: firstStr(payload, 'plan_tier'),
        message: stale ? 'Status data is stale — run `agy` to refresh' : null,
    };
}

// ---------------------------------------------------------------- OpenCode
// auth.json: ~/.local/share/opencode/auth.json
//   { "opencode": {"type":"api","key":"..."}, "opencode-go": {"type":"api","key":"..."} }
// probe: GET https://opencode.ai/zen/v1/models (Bearer)
// billing (cookie auth): SolidStart server-fn RPC, seroval-encoded response

export function readOpenCodeKeys() {
    const xdg = GLib.getenv('XDG_DATA_HOME');
    const path = xdg
        ? `${xdg}/opencode/auth.json`
        : GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'opencode', 'auth.json']);
    const auth = readJsonFile(path);
    const pick = (entry) => (entry && typeof entry === 'object' && entry.type === 'api' && typeof entry.key === 'string' && entry.key) || null;
    const env = GLib.getenv('OPENCODE_API_KEY') || GLib.getenv('ZEN_API_KEY') || null;
    const zen = (env || pick(auth?.opencode));
    const go = auth ? pick(auth['opencode-go']) : null;
    return { path, zen, go };
}

// --- seroval: SolidStart's executable-JS serialization, decoded like
// openusage/internal/providers/opencode/seroval.go (fixture-shaped subset)

// Inline slot values may themselves contain nested `$R[N]=…` definitions, so
// capture recursively (mirrors openusage's captureInlineSlots).
function captureInlineSlots(src, slots) {
    const assignRE = /\$R\[(\d+)\]=/;
    const m = assignRE.exec(src);
    if (!m)
        return src;

    let i = m.index + m[0].length;
    let depth = 0;
    let strCh = null;
    while (i < src.length) {
        const c = src[i];
        if (strCh) {
            if (c === '\\')
                i++;
            else if (c === strCh)
                strCh = null;
        } else if (c === '"' || c === "'" || c === '`') {
            strCh = c;
        } else if ('([{'.includes(c)) {
            depth++;
        } else if (')]}'.includes(c)) {
            if (depth === 0)
                break; // end of the enclosing call — value ended before this
            depth--;
        } else if (c === ',' && depth === 0) {
            break;
        }
        i++;
    }

    let value = src.slice(m.index + m[0].length, i);
    value = captureInlineSlots(value, slots); // resolve nested inline assigns
    slots[m[1]] = value;
    return src.slice(0, m.index) + value + captureInlineSlots(src.slice(i), slots);
}

// Tokenize seroval text into alternating code / string-literal segments.
function tokenizeSeroval(src) {
    const toks = [];
    let code = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            if (code) {
                toks.push({t: 'c', s: code});
                code = '';
            }
            const quote = c;
            let str = c;
            i++;
            while (i < n) {
                const d = src[i];
                str += d;
                i++;
                if (d === '\\' && i < n) {
                    str += src[i];
                    i++;
                } else if (d === quote) {
                    break;
                }
            }
            toks.push({t: 's', s: str});
        } else {
            code += c;
            i++;
        }
    }
    if (code)
        toks.push({t: 'c', s: code});
    return toks;
}

const joinToks = (toks) => toks.map((t) => t.s).join('');

function resolveSerovalRefs(src, slots) {
    const toks = tokenizeSeroval(src);
    for (const t of toks) {
        if (t.t === 'c')
            t.s = t.s.replace(/\$R\[(\d+)\]/g, (mm, n) => (n in slots ? slots[n] : 'null'));
    }
    return joinToks(toks);
}

export function parseSeroval(body) {
    const wm = body.match(/^\s*;0x[0-9a-fA-F]+;\(\(self\.\$R=self\.\$R\|\|\{\}\)\["server-fn:\d+"\]=\[\],\(\$R=>([\s\S]+)\)\(\$R\["server-fn:\d+"\]\)\)\s*$/);
    if (!wm)
        throw new Error('seroval: response body does not match expected wrapper');
    let src = wm[1];

    const slots = {};
    src = captureInlineSlots(src, slots);

    for (let i = 0; i < 3; i++) {
        const before = src;
        src = resolveSerovalRefs(src, slots);
        if (src === before)
            break;
    }

    // `new Date("…")` spans a code/string/code token boundary — handle it
    // on the token stream: drop the constructor, keep the quoted string.
    const toks = tokenizeSeroval(src);
    for (let i = 0; i < toks.length - 2; i++) {
        const a = toks[i];
        if (a.t === 'c' && /new\s+Date\($/.test(a.s) && toks[i + 1].t === 's' &&
            toks[i + 2].t === 'c' && toks[i + 2].s.startsWith(')')) {
            a.s = a.s.replace(/new\s+Date\($/, '');
            toks[i + 2].s = toks[i + 2].s.slice(1);
        }
    }

    const out = joinToks(toks.map((t) => t.t === 's' ? t : {
        t: 'c',
        s: t.s
            .replace(/!([01])\b/g, (mm, b) => (b === '0' ? 'true' : 'false'))
            .replace(/([{,])\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":'),
    }));

    return JSON.parse(out);
}

// server-fn ids pinned from openusage (rotate on upstream deploys)
const RPC_BILLING_INFO_ID = 'c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d';

function serovalArgsPayload(args) {
    const enc = args.map((a) => (typeof a === 'number' ? { t: 0, s: a } : { t: 1, s: String(a) }));
    return JSON.stringify({ t: 9, i: 0, l: enc.length, a: enc, o: 0 });
}

async function consoleCall(session, cookieName, cookie, fnId, args) {
    const url = `https://opencode.ai/_server?id=${encodeURIComponent(fnId)}&args=${encodeURIComponent(serovalArgsPayload(args))}`;
    const res = await httpGet(session, url, {
        Accept: '*/*',
        'x-server-id': fnId,
        'x-server-instance': 'openusage-gnome',
        Cookie: `${cookieName}=${cookie}`,
    });
    if (res.status === 401 || res.status === 403) {
        const err = new Error(`console auth failed (HTTP ${res.status}) — re-copy the '${cookieName}' cookie`);
        err.auth = true;
        throw err;
    }
    if (res.status >= 400)
        throw new Error(`console HTTP ${res.status}`);
    return parseSeroval(res.body);
}

async function discoverWorkspace(session, cookieName, cookie) {
    const res = await httpGet(session, 'https://opencode.ai/auth', {
        Cookie: `${cookieName}=${cookie}`,
    }, { noRedirect: true });
    if (res.status === 401 || res.status === 403)
        throw new Error(`cookie rejected (HTTP ${res.status})`);
    const loc = res.location ?? '';
    const m = loc.match(/\/workspace\/([^/?#]+)/);
    if (!m)
        throw new Error('workspace redirect missing id — cookie valid?');
    return m[1];
}

async function probeZen(session, key, url = 'https://opencode.ai/zen/v1/models') {
    const res = await httpGet(session, url, {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
    });
    if (res.status === 401 || res.status === 403)
        return { auth: false, models: null, httpStatus: res.status };
    if (res.status === 429)
        return { auth: null, models: null, httpStatus: res.status, limited: true };
    if (res.status !== 200)
        return { auth: null, models: null, httpStatus: res.status };
    let models = null;
    try {
        const j = JSON.parse(res.body);
        if (Array.isArray(j?.data))
            models = j.data.map((x) => x?.id).filter((x) => typeof x === 'string');
    } catch {
        /* keep null */
    }
    return { auth: true, models, httpStatus: res.status };
}

export async function fetchOpenCode(session, { cookie = '', cookieName = 'auth' } = {}) {
    const keys = readOpenCodeKeys();
    const effectiveCookie = (cookie || '').trim();

    if (!keys.zen && !keys.go && !effectiveCookie) {
        return {
            status: 'noauth',
            provider: 'opencode',
            message: 'Not signed in — run `opencode auth login` (or paste console cookie in settings)',
            path: keys.path,
        };
    }

    const result = { status: 'ok', provider: 'opencode', path: keys.path };

    if (keys.zen || keys.go) {
        const probeFor = async (key, url) => {
            try {
                return await probeZen(session, key, url);
            } catch (e) {
                return { auth: null, models: null, httpStatus: 0, error: e.message };
            }
        };
        if (keys.zen)
            result.zen = await probeFor(keys.zen);
        if (keys.go) {
            const goBase = 'https://opencode.ai/zen/go/v1';
            result.go = await probeFor(keys.go, `${goBase}/models`);
            // Go-plan usage limits — API-key authed, no console cookie needed:
            // {usage:{rolling:{status,percent,resetsAt}, weekly:{...}, monthly:{...}}}
            try {
                const uRes = await httpGet(session, `${goBase}/usage`, {
                    Authorization: `Bearer ${keys.go}`,
                    Accept: 'application/json',
                });
                if (uRes.status === 200) {
                    const u = JSON.parse(uRes.body)?.usage ?? {};
                    const labels = { rolling: 'rolling (5h)', weekly: 'weekly', monthly: 'monthly' };
                    result.go.usage = Object.entries(u)
                        .filter(([k, v]) => v && typeof v === 'object' && num(v.percent) !== null)
                        .map(([k, v]) => ({
                            key: k,
                            label: labels[k] ?? k,
                            pct: clampPct(v.percent),
                            status: firstStr(v, 'status'),
                            resetAt: parseResetTime(v.resetsAt),
                        }));
                }
            } catch {
                /* non-fatal */
            }
        }

        const anyAuth = [result.zen, result.go].some((p) => p && p.auth === true);
        const anyRejected = [result.zen, result.go].some((p) => p && p.auth === false);
        if (!anyAuth && anyRejected && !effectiveCookie)
            result.status = 'auth';
    }

    const usagePcts = (result.go?.usage ?? []).map((w) => w.pct);
    if (usagePcts.length)
        result.maxPct = Math.max(...usagePcts);

    if (effectiveCookie) {
        try {
            const ws = await discoverWorkspace(session, cookieName, effectiveCookie);
            const billing = await consoleCall(session, cookieName, effectiveCookie, RPC_BILLING_INFO_ID, [ws]);
            const CENTS = 1e8; // openusage parity: wire value / 1e8 = USD
            result.billing = {
                workspace: ws,
                balance: num(billing.balance) !== null ? billing.balance / CENTS : null,
                monthlyUsage: num(billing.monthlyUsage) !== null ? billing.monthlyUsage / CENTS : null,
                monthlyLimit: num(billing.monthlyLimit) !== null ? billing.monthlyLimit / CENTS : null,
                subscriptionPlan: firstStr(billing, 'subscriptionPlan'),
                hasSubscription: billing.subscriptionID != null || !!firstStr(billing, 'subscriptionPlan'),
                last4: firstStr(billing, 'paymentMethodLast4'),
            };
            if (result.billing.monthlyUsage !== null && result.billing.monthlyLimit)
                result.maxPct = clampPct((result.billing.monthlyUsage / result.billing.monthlyLimit) * 100);
            else if (result.billing.monthlyUsage !== null)
                result.maxPct = 0;
        } catch (e) {
            result.cookieError = e.message;
            if (e.auth && result.status === 'ok' && !result.zen && !result.go)
                result.status = 'auth';
        }
    }

    return result;
}

// test hook
export const _extractLimitRowsForTest = extractLimitRows;
