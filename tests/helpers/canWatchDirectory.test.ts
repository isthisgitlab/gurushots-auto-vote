/**
 * The probe decides in a child process, invisible to coverage and to every other assertion, so its six verdicts are pinned here: a preload replaces
 * fs.watch in the child with a stub whose scripted events stand in for the host's, which keeps the outcome deterministic on every host, a wedged one
 * included.
 */

jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PROBE } from './canWatchDirectory';

/** What execFileSync throws when the probe child exits non-zero (or is killed): its status and piped stderr. Checked by shape, not instanceof: the error
 * comes from Node's realm, not Jest's vm. */
type ProbeChildError = { status: number | null; stderr: Buffer | string };

const isProbeChildError = (error: unknown): error is ProbeChildError =>
    typeof error === 'object' && error !== null && 'status' in error && 'stderr' in error;

// The child's fs.watch: an EventEmitter carrying close(), which the probe calls before exiting. GS_PROBE_STUB scripts what, if anything, the watch
// delivers — nothing (silent), another file's name (foreign), the probe file's name (probe), no name at all (unnamed), or a refusal: 'error' after the
// watch was made (error), or a sync throw out of fs.watch itself (throw).
const PRELOAD = `
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const filenames = { foreign: 'gs-probe-abc123', probe: 'probe', unnamed: null };
fs.watch = (_dir, listener) => {
    const mode = process.env.GS_PROBE_STUB;
    if (mode === 'throw') throw new Error('watch refused');
    const watcher = new EventEmitter();
    watcher.close = () => {};
    if (listener) watcher.on('change', listener);
    if (mode === 'error') setImmediate(() => watcher.emit('error'));
    else {
        const filename = filenames[mode];
        if (filename !== undefined) setImmediate(() => watcher.emit('change', 'rename', filename));
    }
    return watcher;
};
`;

describe('the canWatchDirectory probe (fs.watch stubbed in the child)', () => {
    let root: string;
    let preload: string;

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-probe-test-'));
        preload = path.join(root, 'silent-watch-stub.js');
        fs.writeFileSync(preload, PRELOAD);
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    /** Runs the probe child with the stub preloaded; a non-zero exit comes back as status and stderr instead of a throw. */
    const runProbe = (mode: string): { status: number | null; stderr: string } => {
        try {
            execFileSync(process.execPath, ['-r', preload, '-e', PROBE], {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 10_000,
                env: { ...process.env, GS_PROBE_STUB: mode },
            });
            return { status: 0, stderr: '' };
        } catch (error) {
            if (!isProbeChildError(error)) throw error;
            return { status: error.status, stderr: error.stderr.toString() };
        }
    };

    // Above the probe child's own 10 s bound, so a hung child fails as a status assertion, not a Jest timeout.
    const CHILD_BOUND_PLUS = 12_000;

    test.each([
        { mode: 'silent', status: 1, name: 'a watch that never delivers an event exits 1, without crashing' },
        { mode: 'foreign', status: 1, name: 'an event naming another file does not satisfy the gate' },
        { mode: 'error', status: 1, name: "a watch's refusal, the 'error' event, exits 1, without crashing" },
        { mode: 'throw', status: 1, name: 'a watch refused outright, the sync throw, exits 1, without crashing' },
        { mode: 'probe', status: 0, name: "the probe file's event passes" },
        { mode: 'unnamed', status: 0, name: 'an event with no filename passes' },
    ])(
        '$name',
        ({ mode, status }) => {
            const run = runProbe(mode);
            expect(run.status).toBe(status);
            if (status === 1) expect(run.stderr).toBe('');
        },
        CHILD_BOUND_PLUS,
    );
});
