// Run with gjs -m test/opencode-auth.js; no real credentials or network.
import GLib from 'gi://GLib';
import * as P from '../openusage@foxxy/providers.js';

function check(condition, label) {
    if (!condition) throw new Error(label);
    print(`✔ ${label}`);
}

const dir = GLib.dir_make_tmp('openusage-test-XXXXXX');
const authPath = GLib.build_filenamev([dir, 'auth.json']);
try {
    GLib.file_set_contents(authPath, JSON.stringify({'opencode-go': {type: 'api', key: 'sk-go'}}));
    check(P.readOpencodeGoKeyFromAuthFile(authPath) === 'sk-go',
        'reads the OpenCode Go key from auth.json');
    GLib.file_set_contents(authPath, JSON.stringify({'opencode-go': {type: 'api', key: '  '}}));
    check(P.readOpencodeGoKeyFromAuthFile(authPath) === null, 'rejects a blank auth.json key');
    GLib.file_set_contents(authPath, JSON.stringify({'opencode': {type: 'api', key: 'zen-key'}}));
    check(P.readOpencodeGoKeyFromAuthFile(authPath) === null,
        'does not use the Zen key for Go');
    GLib.file_set_contents(authPath, '{broken');
    check(P.readOpencodeGoKeyFromAuthFile(authPath) === null, 'handles a corrupt auth.json');
    check(P.readOpencodeGoKeyFromAuthFile(GLib.build_filenamev([dir, 'missing.json'])) === null,
        'handles a missing auth.json');
    check(P.opencodeAuthPath(dir) === authPath, 'builds the auth path inside the data directory');

    // OpenCode 2 keeps the credential in its channel database.
    const python = GLib.find_program_in_path('python3');
    if (python) {
        const dbPath = GLib.build_filenamev([dir, 'opencode.db']);
        const script = [
            'import sqlite3, sys',
            'db = sqlite3.connect(sys.argv[1])',
            'db.execute("CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL,'
            + ' value text NOT NULL, connector_id text, method_id text, active integer,'
            + ' time_created integer NOT NULL, time_updated integer NOT NULL)")',
            'db.execute("CREATE TABLE migration (id text PRIMARY KEY)")',
            'db.execute("INSERT INTO migration (id) VALUES (?)", (sys.argv[2],))',
            'db.execute("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)'
            + ' VALUES (?, ?, ?, ?, 1, 1, 1)", ("cred_1", "opencode-go", "Go",'
            + ' \'{"type":"key","key":"sk-db"}\'))',
            'db.commit()',
        ].join('\n');
        const [ok] = GLib.spawn_sync(null, [python, '-c', script, dbPath, P.OPENCODE_CREDENTIAL_MIGRATION ?? ''],
            null, GLib.SpawnFlags.SEARCH_PATH, null);
        if (ok) {
            const state = await P.readOpencodeGoKeyFromDatabase(dir);
            check(state.key === 'sk-db' && state.authoritative,
                'reads the OpenCode Go key from the OpenCode 2 database');
            const drop = GLib.spawn_sync(null, [python, '-c',
                'import sqlite3, sys\n'
                + 'db = sqlite3.connect(sys.argv[1])\n'
                + 'db.execute("DELETE FROM credential")\n'
                + 'db.commit()\n', dbPath], null, GLib.SpawnFlags.SEARCH_PATH, null);
            if (drop[0]) {
                const loggedOut = await P.readOpencodeGoKeyFromDatabase(dir);
                check(loggedOut.key === null && loggedOut.authoritative,
                    'reports a logged out OpenCode 2 credential');
            }
        } else {
            print('… skipped the database check (python3 could not create the fixture)');
        }
    } else {
        print('… skipped the database check (python3 not found)');
    }
} finally {
    GLib.unlink(authPath);
    GLib.unlink(GLib.build_filenamev([dir, 'opencode.db']));
    GLib.rmdir(dir);
}
print('ALL PASSED');
