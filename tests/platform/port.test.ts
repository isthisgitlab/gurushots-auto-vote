/**
 * The Platform port's install contract: platform() throws when nothing is
 * installed, the same object installs twice as one, a different object is
 * refused, the test-only reset clears the slot, and the slot lives on
 * globalThis — a fresh module instance after jest.resetModules still sees it.
 */

import { buildNodeTestPlatform, clearInstalledPlatform, installTestPlatform } from '../helpers/platform';
import { installPlatform, platform } from '../../src/ts/platform/port';

import type { ElectronPlatform, PlatformWindows } from '../../src/ts/platform/port';
import type * as portModule from '../../src/ts/platform/port';

describe('the platform port', () => {
    test('platform() throws when nothing is installed', () => {
        clearInstalledPlatform();
        expect(() => platform()).toThrow(
            'No platform is installed: the entry point must import its platform module first',
        );
    });

    test('installing the object that is already installed does nothing', () => {
        const p = installTestPlatform();
        installPlatform(p);
        expect(platform()).toBe(p);
    });

    test('a different object is refused', () => {
        installTestPlatform();
        expect(() => installPlatform(buildNodeTestPlatform())).toThrow('A different platform is already installed');
    });

    test('the test-only reset clears the slot', () => {
        installTestPlatform();
        clearInstalledPlatform();
        expect(() => platform()).toThrow('No platform is installed');
    });

    test('the slot survives jest.resetModules', () => {
        const p = installTestPlatform();
        jest.resetModules();
        jest.isolateModules(() => {
            const fresh = require('../../src/ts/platform/port') as typeof portModule;
            expect(fresh.platform()).toBe(p);
        });
    });

    test('the Electron platform shape takes the node family with a required clearSession and windows', () => {
        const node = buildNodeTestPlatform();
        const electron: ElectronPlatform = {
            ...node,
            wipe: { ...node.wipe, clearSession: async () => undefined },
            // The node family's no-op windows are real members; the spread reads them as nullable.
            windows: node.windows as PlatformWindows,
        };
        expect(electron.wipe.clearSession).not.toBeNull();
        expect(electron.windows).not.toBeNull();
    });
});
