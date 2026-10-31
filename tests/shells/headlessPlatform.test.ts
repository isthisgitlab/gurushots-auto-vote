/**
 * The headless service's platform module: it installs the headless family
 * with the explicit no-op windows when it loads — the service itself is the
 * native side, so the native members are the nulls and the values are the
 * family's answers for the one-cycle-per-alarm service. The installed object
 * is captured once: the setup file's afterEach reinstalls the node test
 * platform on the port, so the tests read the captured object, not the slot.
 */

import { platform } from '../../src/ts/platform/port';
import { clearInstalledPlatform } from '../helpers/platform';

import type { Platform } from '../../src/ts/platform/port';

// Requiring the module installs the platform; the slot is cleared first,
// because the setup file installed the node test platform before this file
// loaded.
clearInstalledPlatform();
require('../../src/ts/headless/platform');
const installed: Platform = platform();

describe('the headless shell platform module', () => {
    test('the module installs the platform, with the family the service runs', () => {
        expect(installed).toBeDefined();
        expect(installed.native).toEqual({ autovote: null, foregroundService: null, apkInstaller: null });
    });

    test('the capabilities answer the headless values', () => {
        const capabilities = installed.capabilities;
        // The headless cycle has no pass-scoped fetch, and Snap is skipped
        // there; recovery names the store to clear; the log context answers
        // CLI without Electron and the hourly cleanup is not armed.
        expect(capabilities.refreshMissionNeeds).toBe(true);
        expect(capabilities.snapAllowed).toBe(false);
        expect(capabilities.backgroundServiceOwnsScenarios()).toBe(false);
        expect(capabilities.recoveryWording).toBe('store');
        expect(capabilities.logContext()).toBe('CLI');
        expect(capabilities.logCleanup).toBe(false);
    });

    test('the windows are the explicit no-ops', () => {
        expect(() => installed.windows.broadcastSettingsChanged({})).not.toThrow();
        expect(() => installed.windows.afterWipe()).not.toThrow();
    });
});

// The light-chain suite stands last: its jest.doMock registration is cleaned
// in its own afterEach, and nothing after it needs the logger mock. The
// module's import chain is the port and the family builder only — the
// install must run before the logger loads.
describe('loading the headless shell platform module loads no heavy module', () => {
    const HEAVY = ['../../src/ts/logger'];
    let mockLoaded: string[];

    beforeEach(() => {
        mockLoaded = [];
    });

    afterEach(() => {
        for (const heavy of HEAVY) jest.dontMock(heavy);
    });

    test('loading installs the platform without touching the logger', () => {
        jest.isolateModules(() => {
            clearInstalledPlatform();
            for (const heavy of HEAVY) {
                jest.doMock(heavy, () => {
                    mockLoaded.push(heavy);
                    return {};
                });
            }
            require('../../src/ts/headless/platform');
            expect(mockLoaded).toEqual([]);
            expect(platform()).toBeDefined();
        });
    });
});
