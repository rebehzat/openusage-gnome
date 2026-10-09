// Run with gjs -m test/run.js; add --live for a real usage request.
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
const credits = P.parseGrokCredits({config: {creditUsagePercent: 42.5,
    currentPeriod: {type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-16T07:16:51.000Z'},
    productUsage: [{product: 'GrokBuild', usagePercent: 40}, {product: 'GrokChat', usagePercent: 2.5}]}});
check(credits.usedPct === 42.5 && credits.resetAt === Date.parse('2026-10-16T07:16:51.000Z') / 1000,
    'reads the Grok Build weekly pool rather than a product share');
check(P.parseGrokCredits({config: {currentPeriod: {end: '2026-10-16T07:16:51.000Z'}}}).usedPct === null,
    'does not invent a Grok Build percent when the CLI omits it');
const frame = Uint8Array.from([
    0, 0, 0, 0, 86, 10, 84, 13, 0, 0, 128, 63, 18, 0, 26, 0, 34, 12, 8, 227, 169, 162, 214, 6, 16, 144, 239,
    223, 167, 3, 42, 12, 8, 227, 158, 199, 214, 6, 16, 144, 239, 223, 167, 3, 58, 7, 8, 2, 21, 0, 0, 128, 63,
    66, 30, 8, 2, 18, 12, 8, 227, 169, 162, 214, 6, 16, 144, 239, 223, 167, 3, 26, 12, 8, 227, 158, 199, 214,
    6, 16, 144, 239, 223, 167, 3, 88, 1, 98, 0, 104, 1, 128, 0, 0, 0, 15,
]);
const grpc = P.parseGrokCreditsFrame(frame);
check(grpc.usedPct === 1 && grpc.resetAt === 1792135011,
    'reads the Grok Build gRPC credit percent and reset');
const built = P.grokBuildResult({usedPct: null, resetAt: 1792135011}, 'X Premium+');
check(built.windows.length === 0 && built.plan === 'X Premium+', 'keeps an unreported Grok Build pool empty');
check(P.grokBuildResult({usedPct: 1, resetAt: 1792135011}).windows[0].usedPct === 1, 'reports an explicit Grok Build percent');
const bot = P.parseGrokBotUsage({usagePercent: 1.956, nextResetTimestampUtc: '2026-10-16T07:18:29.247Z',
    hasNonZeroIncludedLimit: true, grokPlanLabel: 'X Premium+'});
check(bot.windows[0].usedPct === 1.956 && bot.plan === 'X Premium+' && bot.windows[0].resetAt,
    'reads Grok Bot weekly usage');
check(P.parseGrokBotUsage({hasNonZeroIncludedLimit: false, grokPlanLabel: 'Free'}).windows.length === 0,
    'does not draw a meter when Grok Bot has no included allowance');
if (ARGV.includes('--live')) {
    const session = P.mkSession();
    try {
        const result = await P.fetchCodex(session);
        check(result.status === 'ok', `Codex live status: ${result.status}${result.message ? ` (${result.message})` : ''}`);
        check(result.windows.length === 1, 'Codex returned weekly usage');
        print(`ChatGPT weekly remaining: ${100 - result.windows[0].usedPct}%`);
        const grok = await P.fetchGrokBuild(session);
        check(grok.status === 'ok', `Grok Build live status: ${grok.status}${grok.message ? ` (${grok.message})` : ''}`);
        check(grok.windows.length === 1, 'Grok Build returned weekly usage');
        print(`Grok Build remaining: ${100 - grok.windows[0].usedPct}%`);
        const botUsage = await P.fetchGrokBot(session);
        check(botUsage.status === 'ok', `Grok Bot live status: ${botUsage.status}${botUsage.message ? ` (${botUsage.message})` : ''}`);
        check(botUsage.windows.length === 1, 'Grok Bot returned weekly usage');
        print(`Grok Bot remaining: ${100 - botUsage.windows[0].usedPct}%`);
    } finally { session.abort(); }
}
print('ALL PASSED');
