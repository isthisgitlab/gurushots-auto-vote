/**
 * The scripts' platform module: plain Node over the node family — it
 * installs with the explicit no-op windows when it loads, and the values are
 * the family's answers for a script run (no Electron, not started through
 * cli.ts). The installed object is captured once: the setup file's afterEach
 * reinstalls the node test platform on the port, so the tests read the
 * captured object, not the slot.
 */

import { platform } from '../../src/ts/platform/port';
import { clearInstalledPlatform } from '../helpers/platform';

import type { Platform } from '../../src/ts/platform/port';

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
