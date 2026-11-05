/**
 * The web shell's platform module: it installs the node family with the web
 * server's windows when it loads, and the windows delegate to the run the
 * server registered (setWebShellRun) — with none registered they are no-ops.
 * The installed object is captured once: the setup file's afterEach
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
const webPlatform = require('../../src/ts/shells/web/platform') as typeof import('../../src/ts/shells/web/platform');
const installed: Platform = platform();

describe('the web shell platform module', () => {
    afterEach(() => {
        webPlatform.setWebShellRun(null);
    });

    test('the module installs the platform, and the capabilities answer the web values', () => {
        expect(installed).toBeDefined();
        const capabilities = installed.capabilities;
        expect(capabilities.refreshMissionNeeds).toBe(false);
        expect(capabilities.snapAllowed).toBe(true);
        expect(capabilities.backgroundServiceOwnsScenarios()).toBe(false);
        expect(capabilities.recoveryWording).toBe('file');
        // A browser page is no Electron: the logger context answers CLI, and
        // the hourly cleanup is not armed.
        expect(capabilities.logContext()).toBe('CLI');
        expect(capabilities.logCleanup).toBe(false);
    });

    test('with no run registered the windows are no-ops', () => {
        webPlatform.setWebShellRun(null);
        expect(() => installed.windows.broadcastSettingsChanged({})).not.toThrow();
        expect(() => installed.windows.afterWipe()).not.toThrow();
    });

    test('the windows delegate to the registered run', () => {
        const emit = jest.fn<void, [string, unknown]>();
        const afterWipe = jest.fn<void, []>();
        webPlatform.setWebShellRun({ emit, afterWipe });
        const settings = { theme: 'dark' };
        installed.windows.broadcastSettingsChanged(settings);
        expect(emit).toHaveBeenCalledWith('settings-changed', settings);
        installed.windows.afterWipe();
        expect(afterWipe).toHaveBeenCalledTimes(1);
    });
});

// The light-chain suite stands last: its jest.doMock registration is cleaned
// in its own afterEach, and nothing after it needs the logger mock. The
// module's import chain is the port and the family builder only — the
// install must run before the logger loads.
describe('loading the web shell platform module loads no heavy module', () => {
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
            require('../../src/ts/shells/web/platform');
            expect(mockLoaded).toEqual([]);
            expect(platform()).toBeDefined();
        });
    });
});
