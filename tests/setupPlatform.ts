/**
 * The node project's platform setup (package.json setupFilesAfterEnv, after
 * tests/setup.ts). It installs the node test platform for every test file and
 * reinstalls it after each test, so a test that swapped the platform leaves
 * the node one standing, and removes the file's temporary user-data directory
 * in an afterAll. It also refuses to run against the real home: a platform
 * whose paths.userData() resolves inside os.homedir() would let a test read
 * or write the dev account's real configuration, so the guard throws and
 * names the resolved path. The guard still checks the real home — rather
 * than only the temporary directory — because the resolution it must catch is
 * the one that ignores the test override and lands in the dev account's own
 * user data; a TMPDIR set inside the real home would trip it too, and that
 * is the check working, not a false alarm.
 */

import * as os from 'node:os';

import { platform } from '../src/ts/core/platform/port';
import { installTestPlatform, removeNodeTestUserDataDir, restoreNodeTestPlatform } from './helpers/platform';

installTestPlatform();

/**
 * Throws when the installed platform's paths.userData() resolves inside the
 * real home directory.
 */
const assertTestUserDataIsIsolated = (): void => {
    const home = os.homedir();
    const dir = platform().paths.userData();
    if (dir === home || dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`)) {
        throw new Error(`the node test platform resolved user data inside the real home: ${dir}`);
    }
};

assertTestUserDataIsIsolated();

afterEach(() => {
    restoreNodeTestPlatform();
});

afterAll(() => {
    removeNodeTestUserDataDir();
});

export { assertTestUserDataIsIsolated };
