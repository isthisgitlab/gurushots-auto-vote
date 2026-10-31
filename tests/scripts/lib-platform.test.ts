/**
 * The scripts' platform module: plain Node over the node family — it
 * installs with the explicit no-op windows when it loads, and the values are
 * the family's answers for a script run (no Electron, not started through
 * cli.ts). The installed object is captured once: the setup file's afterEach
 * reinstalls the node test platform on the port, so the tests read the
 * captured object, not the slot.
 */

import { platform } from '../../src/ts/core/platform/port';
import { clearInstalledPlatform } from '../helpers/platform';

import type { Platform } from '../../src/ts/core/platform/port';

// Requiring the module installs the platform; the slot is cleared first,
// because the setup file installed the node test platform before this file
// loaded.
clearInstalledPlatform();
require('../../scripts/lib/platform');
const installed: Platform = platform();

describe('the scripts platform module', () => {
    test('the module installs the platform, and the windows are the explicit no-ops', () => {
        expect(installed).toBeDefined();
        expect(() => installed.windows.broadcastSettingsChanged({})).not.toThrow();
        expect(() => installed.windows.afterWipe()).not.toThrow();
    });

    test('the capabilities answer the script values', () => {
        const capabilities = installed.capabilities;
        expect(capabilities.refreshMissionNeeds).toBe(false);
        expect(capabilities.snapAllowed).toBe(true);
        expect(capabilities.backgroundServiceOwnsScenarios()).toBe(false);
        expect(capabilities.recoveryWording).toBe('file');
        expect(capabilities.logContext()).toBe('CLI');
        expect(capabilities.logCleanup).toBe(false);
    });
});

// The light-chain suite stands last: its jest.doMock registration is cleaned
// in its own afterEach, and nothing after it needs the logger mock. The
// module's import chain is the port and the family builder only — the
// install must run before the logger loads.
describe('loading the scripts platform module loads no heavy module', () => {
    const HEAVY = ['../../src/ts/core/logger'];
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
            require('../../scripts/lib/platform');
            expect(mockLoaded).toEqual([]);
            expect(platform()).toBeDefined();
        });
    });
});
