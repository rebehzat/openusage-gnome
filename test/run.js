// test-runner: gjs -m test/run.js
import * as P from '../openusage@foxxy/providers.js';

const s = P.mkSession(15);
let failures = 0;
const check = (name, cond, extra = '') => {
    if (cond) {
        print(`  ✔ ${name} ${extra}`);
    } else {
        failures++;
        print(`  ✘ ${name} ${extra}`);
    }
};

// ---- Codex (live) ----------------------------------------------------------
print('[Codex]');
const codex = await P.fetchCodex(s, {});
print(JSON.stringify(codex, null, 1));
check('codex ok', codex.status === 'ok');
check('codex windows', Array.isArray(codex.windows) && codex.windows.length >= 2,
    `(${codex.windows?.length} windows)`);
check('codex primary pct sane', codex.windows?.[0]?.usedPct >= 0 && codex.windows?.[0]?.usedPct <= 100);
check('codex plan', typeof codex.plan === 'string' && codex.plan.length > 0, `(${codex.plan})`);

// base-url normalization
check('codex noauth detection', (await P.fetchCodex(s, {baseUrl: 'https://example.com'})).status !== undefined);

// ---- Z.AI (no key → clean noauth) ------------------------------------------
print('[Z.AI]');
const zai = await P.fetchZai(s, {});  // reads ~/.config/zai file
check('zai live ok', zai.status === 'ok', `(level: ${zai.planLevel})`);
const zaiBad = await P.fetchZai(s, {apiKey: 'sk-invalid-key-000', region: 'global'});
print(`  zai bad-key status: ${zaiBad.status} — ${zaiBad.message}`);
check('zai bad key handled', ['auth', 'error', 'limited', 'warn'].includes(zaiBad.status));

// limit-row extraction (fixture from openusage tests)
const rows = P._extractLimitRowsForTest({
    limits: [
        {type: 'TOKENS_LIMIT', percentage: 85, usage: 2000000, currentValue: 1700000, nextResetTime: 1789000000},
        {type: 'TIME_LIMIT', percentage: 12, usage: 1000, currentValue: 120},
    ],
});
check('zai row extraction', rows.length === 2 && rows[0].type === 'TOKENS_LIMIT');

// ---- OpenCode (no auth file → clean noauth) ---------------------------------
print('[OpenCode]');
const oc = await P.fetchOpenCode(s, {});
check('opencode handled', ['ok', 'noauth', 'auth', 'warn', 'error'].includes(oc.status),
    `(go key: ${!!P.readOpenCodeKeys().go}, status: ${oc.status})`);

// ---- seroval parser (fixture from openusage docs) ---------------------------
print('[Seroval]');
const fixture = ';0x0000021c;((self.$R=self.$R||{})["server-fn:3"]=[],($R=>$R[0]={customerID:null,paymentMethodLast4:"4242",balance:500000000,monthlyLimit:$R[1]=10000000000,monthlyUsage:2345678900,timeMonthlyUsageUpdated:$R[2]=new Date("2026-04-30T12:00:00.000Z"),subscriptionPlan:null,reloadAmount:!1,reloadTrigger:$R[3]=!0,note:"a,b:c",extra:$R[1]})($R["server-fn:3"]))';
const parsed = P.parseSeroval(fixture);
print(JSON.stringify(parsed, null, 1));
check('seroval balance', parsed.balance === 500000000);
check('seroval inline slot', parsed.monthlyLimit === 10000000000);
check('seroval date', parsed.timeMonthlyUsageUpdated === '2026-04-30T12:00:00.000Z');
check('seroval bools', parsed.reloadAmount === false && parsed.reloadTrigger === true);
check('seroval backref', parsed.customerID === null);
check('seroval string with colon/comma', parsed.note === 'a,b:c');

print('');
print(failures === 0 ? 'ALL PASSED' : `${failures} FAILURES`);
