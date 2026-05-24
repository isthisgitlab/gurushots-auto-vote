/**
 * Minimal CLI smoke tests. The CLI is process-level glue that's awkward
 * to import directly — run it as a child process and assert exit code +
 * recognisable output substrings. Mock mode is whatever the user's
 * settings file says; both commands tested here are read-only so they
 * don't depend on mock vs real.
 */

const { spawnSync } = require('node:child_process');
// tests/setup.js mocks path with stubs that return undefined, which
// breaks path.resolve. Reach through to the real module.
const path = jest.requireActual('path');

const CLI_PATH = path.resolve(__dirname, '../../src/js/cli/cli.js');

// Each case cold-spawns a fresh `node` running the full CLI. Inside the full
// parallel jest run every core is busy with workers, so a cold child can take
// well over the global 10s timeout and get killed (status === null). These are
// correctness smoke tests, not a perf budget — give the spawn (25s) and the
// test (40s, clear headroom over the spawn cap) generous room. Scoped to this
// file; the global 10s in tests/setup.js stays for everything else.
jest.setTimeout(40000);

const runCli = (args) => {
    const result = spawnSync('node', [CLI_PATH, ...args], {
        encoding: 'utf8',
        timeout: 25000,
    });
    // A timeout kill (or spawn failure) leaves status === null. Surface it as a
    // descriptive error rather than letting it resurface downstream as an opaque
    // `expect(exitCode).toBe(0) // Received: null` — which is exactly what made
    // the original flake hard to diagnose.
    if (result.error || result.signal) {
        throw new Error(
            `CLI \`${args.join(' ')}\` did not exit normally: ${result.error?.message ?? `killed by ${result.signal}`}`,
        );
    }
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('CLI smoke', () => {
    test('help: exits 0 and lists every command', () => {
        const { exitCode, stdout } = runCli(['help']);
        expect(exitCode).toBe(0);

        // The help output is the contract — every command should appear
        // somewhere in it. If a new command is added without help text it
        // will fail this test, which is the point.
        const expectedCommands = [
            'login',
            'logout',
            'vote',
            'run',
            'boost',
            'turbo',
            'fill',
            'start',
            'status',
            'check-updates',
            'get-setting',
            'set-setting',
            'set-global-default',
            'list-settings',
            'reset-setting',
            'reset-all-settings',
            'logs',
            'help-settings',
            'reset-windows',
            'help',
        ];
        for (const cmd of expectedCommands) {
            expect(stdout).toContain(cmd);
        }
    });

    test('status: exits 0 and reports mode', () => {
        const { exitCode, stdout } = runCli(['status']);
        expect(exitCode).toBe(0);
        // status either says MOCK or REAL — both are valid.
        expect(stdout).toMatch(/(MOCK|REAL)/i);
    });

    test('vote --challenge= (empty value) errors instead of voting every challenge', () => {
        // Guards against the dangerous footgun: a malformed --challenge must
        // NOT fall through to the bare-vote path (which votes ALL challenges).
        const { exitCode, stdout, stderr } = runCli(['vote', '--challenge=']);
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toMatch(/specify a challenge/i);
    });

    test('boost without --challenge exits non-zero with usage', () => {
        const { exitCode, stdout, stderr } = runCli(['boost']);
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toMatch(/--challenge/);
    });

    test('unknown command: exits non-zero or prints help', () => {
        // The CLI may treat unknown commands as either an error
        // (non-zero exit) or fall back to printing help. Either is
        // acceptable; both branches are covered here so this stays
        // robust against either choice.
        const { exitCode, stdout } = runCli(['totally-not-a-command']);
        const fellBackToHelp = exitCode === 0 && stdout.includes('Commands:');
        const erroredOut = exitCode !== 0;
        expect(fellBackToHelp || erroredOut).toBe(true);
    });
});
