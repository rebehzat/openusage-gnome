import * as P from '../providers.js';
const s = P.mkSession(15);
const z = await P.fetchZai(s, {});  // no key passed → must read ~/.config/zai file
console.log(JSON.stringify(z, null, 1));
