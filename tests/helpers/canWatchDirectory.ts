import { execFileSync } from 'node:child_process';

// A host out of watch handles (EMFILE, or ENOSPC on Linux's inotify) or a sandbox that forbids watching reports the refusal
// as an 'error' event a moment after fs.watch returned, so the probe runs in a child process that can wait for it while the
// caller (a test file registering its tests) stays synchronous.
const PROBE = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-probe-'));
let failed = false;
const finish = (watcher) => {
    watcher?.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
};
try {
    const watcher = fs.watch(dir);
    watcher.on('error', () => {
        failed = true;
    });
    setTimeout(() => finish(watcher), 250);
} catch {
    failed = true;
    finish(null);
}
`;

/** True when this host can watch a directory; decided once with a throwaway watch in a child process. */
export const canWatchDirectory = (): boolean => {
    try {
        execFileSync(process.execPath, ['-e', PROBE], { stdio: 'ignore', timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
};
