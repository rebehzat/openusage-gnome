// Run with gjs -m test/run.js — safe output; no tokens or account identifiers.
import * as P from '../openusage@foxxy/providers.js';

function check(condition, label) {
    if (!condition)
        throw new Error(label);
    print(`  ✔ ${label}`);
}

const session = P.mkSession();
const codexFixture = P.parseCodexUsage({plan_type: 'pro', rate_limit: {
    primary_window: {used_percent: 20, limit_window_seconds: 18000, reset_at: 1790000000},
    secondary_window: {remaining_percent: 70, limit_window_seconds: 604800},
}});
check(codexFixture.windows[0].label === '5h' && codexFixture.windows[1].label === '7d',
    'Codex usage windows');
check(codexFixture.windows[1].usedPct === 30, 'Codex remaining percentage');
const goFixture = P.parseGoUsage({usage: {
    rolling: {percent: 10, resetsAt: '2026-10-01T00:00:00Z'},
    monthly: {percent: 40},
}});
check(goFixture.usage.length === 2 && goFixture.maxPct === 40, 'OpenCode Go usage');

const codex = await P.fetchCodex(session);
check(['ok', 'noauth', 'auth'].includes(codex.status), `Codex live status: ${codex.status}`);
if (codex.status === 'ok')
    check(codex.windows.length > 0, 'Codex returned usage');
const go = await P.fetchOpenCode(session);
check(['ok', 'noauth', 'auth', 'limited'].includes(go.status), `OpenCode Go live status: ${go.status}`);
if (go.status === 'ok')
    check(go.usage.every(w => w.pct >= 0 && w.pct <= 100), 'Go percentages are valid');
print('ALL PASSED');
