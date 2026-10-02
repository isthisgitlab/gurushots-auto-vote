/**
 * The Capacitor bridge has no fs, so skip-update-version is persisted through
 * the settings facade (not metadata.json like Electron). These tests exercise
 * the three update-skip handlers via installBridge()'s window.api surface.
 * The ipc handler modules and update services are mocked to keep the bridge
 * load light.
 */

import type * as capacitorModule from '../../src/ts/bridge/capacitor';
import type { WindowApi } from '../../src/ts/types/ipc';
import type { UpdateSummary } from '../../src/ts/services/AutoUpdater';

let mockSkipStore = '';
const mockCheck = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('../../src/ts/ipc/settings.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/ipc/voting.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/ipc/log.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/ipc/actions.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/ts/services/AndroidUpdateInstaller', () => ({ downloadAndInstall: jest.fn() }));
jest.mock('../../src/ts/services/visionVerifier', () => ({ hasBundledModel: async () => true }));
jest.mock('../../src/ts/services/UpdateChecker', () => ({
    checkForUpdates: (...args: unknown[]) => mockCheck(...args),
    getReleasesUrl: () => 'https://example.com/releases',
}));
jest.mock('../../src/ts/settings', () => ({
    getSetting: jest.fn((key) => (key === 'skipUpdateVersion' ? mockSkipStore : undefined)),
    setSetting: jest.fn((key: string, value: string) => {
        if (key === 'skipUpdateVersion') mockSkipStore = value;
    }),
}));

const g = globalThis as typeof globalThis & { api?: object };

/** Either branch of check-for-updates' result, read without narrowing. */
type CheckResult = { success: boolean; updateInfo?: UpdateSummary | null; error?: string };

describe('Capacitor bridge — update skip', () => {
    let api: WindowApi;

    beforeEach(() => {
        mockSkipStore = '';
        mockCheck.mockReset();
        delete g.api;
        // Reset the module registry so the bridge's module-level
        // lastUpdateInfo cache doesn't leak between tests.
        jest.resetModules();
        const { installBridge } = require('../../src/ts/bridge/capacitor') as typeof capacitorModule;
        api = installBridge();
    });

    test('skip-update-version persists the latest version and suppresses the next check for it', async () => {
        mockCheck.mockResolvedValue({ updateAvailable: true, version: '1.2.3', downloadUrl: 'u' });

        const first: CheckResult = await api.checkForUpdates();
        expect(first.updateInfo).not.toBeNull();

        const skip = await api.skipUpdateVersion();
        expect(skip).toEqual({ success: true, version: '1.2.3' });
        expect(mockSkipStore).toBe('1.2.3');

        const second: CheckResult = await api.checkForUpdates();
        expect(second.updateInfo).toBeNull();
    });

    test('a different version is still surfaced after skipping an older one', async () => {
        mockSkipStore = '1.2.3';
        mockCheck.mockResolvedValue({ updateAvailable: true, version: '1.3.0', downloadUrl: 'u' });

        const res: CheckResult = await api.checkForUpdates();
        expect(res.updateInfo).not.toBeNull();
        expect(res.updateInfo!.latestVersion).toBe('1.3.0');
    });

    test('skip-update-version errors when no update info is cached', async () => {
        const res = await api.skipUpdateVersion();
        expect(res.success).toBe(false);
    });

    test('clear-skip-version resets the skipped version', async () => {
        mockSkipStore = '1.2.3';
        const res = await api.clearSkipVersion();
        expect(res).toEqual({ success: true });
        expect(mockSkipStore).toBe('');
    });
});
