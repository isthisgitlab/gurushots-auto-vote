/**
 * The Platform port's install contract: platform() throws when nothing is
 * installed, the same object installs twice as one, a different object is
 * refused, the test-only reset clears the slot, and the slot lives on
 * globalThis — a fresh module instance after jest.resetModules still sees it.
 */

import { buildNodeTestPlatform, clearInstalledPlatform, installTestPlatform } from '../helpers/platform';
import { installPlatform, platform } from '../../src/ts/core/platform/port';

import type { ElectronPlatform } from '../../src/ts/core/platform/port';
import type * as portModule from '../../src/ts/core/platform/port';

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
            const fresh = require('../../src/ts/core/platform/port') as typeof portModule;
            expect(fresh.platform()).toBe(p);
        });
    });

    test('the Electron platform shape takes the node family with a required clearSession', () => {
        // Object.assign, not a spread: the built platform's members are
        // written over in place without reading the logger's getter graph.
        const node = buildNodeTestPlatform();
        const electron: ElectronPlatform = Object.assign(node, {
            wipe: { ...node.wipe, clearSession: async () => undefined },
        });
        expect(electron.wipe.clearSession).not.toBeNull();
        expect(typeof electron.windows.broadcastSettingsChanged).toBe('function');
    });

    test('a removed test user-data directory is not silently recreated', () => {
        // A second copy of the helper module, with state of its own: the
        // shared directory the file's other tests resolve is not touched.
        jest.isolateModules(() => {
            const isolated = require('../helpers/platform') as typeof import('../helpers/platform');
            isolated.nodeTestUserDataDir();
            isolated.removeNodeTestUserDataDir();
            expect(() => isolated.nodeTestUserDataDir()).toThrow('the test user-data directory was already removed');
        });
    });
});
