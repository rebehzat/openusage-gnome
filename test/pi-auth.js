// Run with: gjs -m test/pi-auth.js (no network or real credentials required)
import GLib from 'gi://GLib';
import * as P from '../openusage@foxxy/providers.js';

function check(condition, label) {
    if (!condition)
        throw new Error(label);
    print(`  ✔ ${label}`);
}

const dir = GLib.dir_make_tmp('openusage-test-XXXXXX');
const path = GLib.build_filenamev([dir, 'auth.json']);
try {
    const fixture = {
        'openai-codex': {type: 'oauth', access: 'test-access', accountId: 'test-account', expires: Date.now() + 60000},
        'opencode-go': {type: 'api_key', key: 'test-go'},
        'anthropic': {type: 'oauth', access: 'must-not-be-used'},
    };
    GLib.file_set_contents(path, JSON.stringify(fixture));
    check(P.readPiAuth(path)['opencode-go'].key === 'test-go', 'loads pi auth entries');
    check(P.readCodexAuth(P.readPiAuth(path)).accessToken === 'test-access', 'Codex uses pi OAuth');
    check(P.readCodexAuth({'openai-codex': {...fixture['openai-codex'], expires: 1}}).expired,
        'expired Codex token is detected');
    check(P.readCodexAuth({'anthropic': fixture.anthropic}) === null, 'Claude cannot be used as Codex');
    const keys = P.readOpenCodeKeys(P.readPiAuth(path));
    check(keys.go === 'test-go', 'OpenCode Go uses pi API key');
    check(P.readOpenCodeKeys({'anthropic': fixture.anthropic}).go === null,
        'Claude cannot be used as OpenCode Go');
    check(P.readPiAuth('/nonexistent/openusage/auth.json')['openai-codex'] === undefined,
        'missing credentials are handled');
    print('ALL PASSED');
} finally {
    GLib.unlink(path);
    GLib.rmdir(dir);
}
