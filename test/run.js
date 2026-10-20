// Run with gjs -m test/run.js; add --live for real usage requests.
import * as P from '../openusage@foxxy/providers.js';
function check(condition, label) {
    if (!condition) throw new Error(label);
    print(`✔ ${label}`);
}
const weekly = {remaining_percent: 70, limit_window_seconds: 604800, reset_at: 1790000000};
const usage = P.parseCodexUsage({plan_type: 'pro', rate_limit: {
    primary_window: {used_percent: 99, limit_window_seconds: 18000}, secondary_window: weekly,
}, additional_rate_limits: [{limit_name: 'other', rate_limit: {secondary_window: weekly}}], credits: {balance: 10}});
check(usage.windows.length === 1 && usage.windows[0].label === 'Weekly' && usage.windows[0].usedPct === 30,
    'shows only weekly usage, excluding short windows and extra limits');
check(usage.windows[0].key === 'weekly', 'keys the ChatGPT window as the weekly one');
check(usage.windows[0].resetAt === 1790000000, 'retains weekly reset time');
check(P.parseCodexUsage({rate_limit_status: {rate_limit: {primary_window: weekly}}}).windows.length === 1,
    'recognizes weekly primary and nested responses');
check(P.parseCodexUsage({rate_limit: {secondary_window: {used_percent: 20}}}).windows.length === 1,
    'supports secondary windows without duration');
check(P.parseCodexUsage({rate_limit: {secondary_window: {used_percent: 20, window_minutes: 300}}}).windows.length === 0,
    'does not mislabel a known short secondary window as weekly');
check(P.parseCodexUsage({}).windows.length === 0, 'handles missing weekly limits');
check(P.parseCodexUsage({rate_limit: {secondary_window: {...weekly, used_percent: 110}}}).windows[0].usedPct === 100,
    'clamps percentages');

const goUsage = P.parseOpencodeGoUsage({usage: {
    rolling: {status: 'ok', percent: 1, resetsAt: '2026-09-30T17:15:45.084Z'},
    weekly: {status: 'ok', percent: 25, resetsAt: '2026-10-05T00:00:00.000Z'},
    monthly: {status: 'ok', percent: 29, resetsAt: '2026-10-21T07:45:46.000Z'},
}});
check(goUsage.length === 3, 'reads the three OpenCode Go windows');
check(goUsage[0].key === 'rolling' && goUsage[0].label === '5-hour' && goUsage[0].usedPct === 1,
    'labels the rolling window');
check(goUsage[1].key === 'weekly' && goUsage[1].usedPct === 25, 'keeps the weekly window');
check(goUsage[2].key === 'monthly' && goUsage[2].usedPct === 29, 'keeps the monthly window');
check(goUsage[1].resetAt === Date.parse('2026-10-05T00:00:00.000Z') / 1000,
    'converts the OpenCode Go reset time to epoch seconds');
check(P.parseOpencodeGoUsage({usage: {weekly: {status: 'ok', percent: 25}}})[0].resetAt === null,
    'tolerates a missing reset time');
check(P.parseOpencodeGoUsage({usage: {weekly: {status: 'ok', percent: 120}}})[0].usedPct === 100,
    'clamps OpenCode Go percentages');
check(P.parseOpencodeGoUsage({usage: {weekly: {status: 'ok'}}}).length === 0,
    'skips a window without a percent');
check(P.parseOpencodeGoUsage({}) === null, 'handles a response without usage');

const exported = P.parseOpencodeExport(JSON.stringify([
    {id: 'cred_1', integrationID: 'opencode', label: 'Zen', active: true, value: {type: 'key', key: 'zen-key'}},
    {id: 'cred_2', integrationID: 'opencode-go', label: 'Go', active: true, value: {type: 'key', key: 'go-key'}},
]));
check(exported === 'go-key', 'picks the opencode-go key out of the exported credentials');
check(P.parseOpencodeExport(JSON.stringify([{integrationID: 'opencode-go', value: {type: 'key', key: ' '}}])) === null,
    'rejects a blank exported key');
check(P.parseOpencodeExport('not json') === null, 'handles a broken export');

if (ARGV.includes('--live')) {
    const session = P.mkSession();
    try {
        const result = await P.fetchCodex(session);
        print(`ChatGPT live status: ${result.status}${result.message ? ` (${result.message})` : ''}`);
        if (result.status === 'ok') {
            check(result.windows.length === 1, 'Codex returned weekly usage');
            print(`ChatGPT weekly remaining: ${100 - result.windows[0].usedPct}%`);
        }
        const go = await P.fetchOpencodeGo(session);
        print(`OpenCode Go live status: ${go.status}${go.message ? ` (${go.message})` : ''}`);
        for (const w of go.windows ?? [])
            print(`OpenCode Go ${w.label} remaining: ${100 - w.usedPct}%`);
    } finally { session.abort(); }
}
print('ALL PASSED');
