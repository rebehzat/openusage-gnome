// Run with gjs -m test/codex-auth.js; no real credentials or network.
import GLib from 'gi://GLib';
import * as P from '../openusage@foxxy/providers.js';
function check(condition, label) {
    if (!condition) throw new Error(label);
    print(`✔ ${label}`);
}
const dir = GLib.dir_make_tmp('openusage-test-XXXXXX');
const path = GLib.build_filenamev([dir, 'auth.json']);
const jwt = exp => `header.${GLib.base64_encode(new TextEncoder().encode(JSON.stringify({exp})))}.signature`;
try {
    const fixture = {tokens: {access_token: jwt(Date.now() / 1000 + 3600), account_id: 'test-account'}};
    GLib.file_set_contents(path, JSON.stringify(fixture));
    const auth = P.readCodexAuth(P.readAuthFile(path));
    check(auth.accessToken === fixture.tokens.access_token && auth.accountId === 'test-account' && !auth.expired,
        'reads Codex OAuth tokens and account');
    check(P.readCodexAuth({tokens: {access_token: jwt(1)}}).expired, 'detects expired JWT');
    check(!P.readCodexAuth({tokens: {access_token: 'opaque-token'}}).expired, 'accepts opaque tokens');
    check(P.readCodexAuth({'openai-codex': {access: 'pi-token'}}) === null, 'does not use Pi credentials');
    check(P.readCodexAuth({OPENAI_API_KEY: 'test-key'}) === null, 'API keys cannot supply ChatGPT plan usage');
    check(P.readCodexAuth({tokens: {access_token: ' '}}) === null, 'rejects blank tokens');
    check(P.readCodexAuth(P.readAuthFile('/nonexistent/auth.json')) === null, 'handles missing credentials');
    GLib.file_set_contents(path, '{broken');
    check(P.readCodexAuth(P.readAuthFile(path)) === null, 'handles corrupt credentials');
    const oldHome = GLib.getenv('CODEX_HOME');
    GLib.setenv('CODEX_HOME', dir, true);
    check(P.codexAuthPath() === path, 'honors CODEX_HOME');
    if (oldHome === null) GLib.unsetenv('CODEX_HOME');
    else GLib.setenv('CODEX_HOME', oldHome, true);
} finally {
    GLib.unlink(path);
    GLib.rmdir(dir);
}
print('ALL PASSED');
