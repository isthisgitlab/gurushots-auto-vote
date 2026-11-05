/**
 * Both directions of the node project's platform setup guard
 * (tests/setupPlatform.ts): it throws when the installed platform's
 * paths.userData() resolves inside the real home, and passes for the
 * temporary directory the node test platform resolves.
 */

import * as os from 'node:os';

import { platform } from '../../src/ts/core/platform/port';
import { assertTestUserDataIsIsolated } from '../setupPlatform';
import { installTestPlatform, restoreNodeTestPlatform } from '../helpers/platform';

describe('the node test platform setup guard', () => {
    test('it throws, naming the path, when userData resolves inside the real home', () => {
        const current = platform();
        installTestPlatform({
            paths: { ...current.paths, userData: () => `${os.homedir()}/gurushots-guard-canary` },
        });
        expect(assertTestUserDataIsIsolated).toThrow('inside the real home');
        expect(assertTestUserDataIsIsolated).toThrow('gurushots-guard-canary');
    });

    test('it passes for the temporary directory the node test platform resolves', () => {
        restoreNodeTestPlatform();
        expect(assertTestUserDataIsIsolated).not.toThrow();
    });
});
