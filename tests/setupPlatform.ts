/**
 * The node project's platform setup (package.json setupFilesAfterEnv, after
 * tests/setup.ts). It installs the node test platform for every test file and
 * reinstalls it after each test, so a test that swapped the platform leaves
 * the node one standing. It also refuses to run against the real home: a
 * platform whose paths.userData() resolves inside os.homedir() would let a
 * test read or write the dev account's real configuration, so the guard
 * throws and names the resolved path.
 */

import * as os from 'node:os';

import { platform } from '../src/ts/platform/port';
import { installTestPlatform, restoreNodeTestPlatform } from './helpers/platform';

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

export { assertTestUserDataIsIsolated };
