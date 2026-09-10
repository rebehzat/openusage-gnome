import * as P from '../openusage@foxxy/providers.js';
const oc = await P.fetchOpenCode(P.mkSession(15), {});
console.log('status:', oc.status);
console.log('go auth:', oc.go?.auth, '| usage windows:', JSON.stringify(oc.go?.usage?.map(u => `${u.label}: ${u.pct}% resets ${u.resetAt ? new Date(u.resetAt*1000).toISOString().slice(0,16) : '?'}`), null, 1));
console.log('maxPct:', oc.maxPct);
