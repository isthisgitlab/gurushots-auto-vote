/**
 * The Capacitor bridge has no fs, so skip-update-version is persisted through
 * the settings facade (not metadata.json like Electron). These tests exercise
 * the three update-skip handlers via installBridge()'s window.api surface.
 * The ipc handler modules and update services are mocked to keep the bridge
 * load light.
 */

let mockSkipStore = '';
const mockCheck = jest.fn();

jest.mock('../../src/js/ipc/settings.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/voting.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/log.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/actions.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/services/AndroidUpdateInstaller', () => ({ downloadAndInstall: jest.fn() }));
jest.mock('../../src/js/services/UpdateChecker', () => ({
    checkForUpdates: (...args) => mockCheck(...args),
    getReleasesUrl: () => 'https://example.com/releases',
}));
jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn((key) => (key === 'skipUpdateVersion' ? mockSkipStore : undefined)),
    setSetting: jest.fn((key, value) => {
        if (key === 'skipUpdateVersion') mockSkipStore = value;
    }),
}));

describe('Capacitor bridge — update skip', () => {
    let api;

    beforeEach(() => {
        mockSkipStore = '';
        mockCheck.mockReset();
        delete globalThis.api;
        // Reset the module registry so the bridge's module-level
        // lastUpdateInfo cache doesn't leak between tests.
        jest.resetModules();
        const { installBridge } = require('../../src/js/bridge/capacitor');
        api = installBridge();
    });

    test('skip-update-version persists the latest version and suppresses the next check for it', async () => {
        mockCheck.mockResolvedValue({ updateAvailable: true, version: '1.2.3', downloadUrl: 'u' });

        const first = await api.checkForUpdates();
        expect(first.updateInfo).not.toBeNull();

        const skip = await api.skipUpdateVersion();
        expect(skip).toEqual({ success: true, version: '1.2.3' });
        expect(mockSkipStore).toBe('1.2.3');

        const second = await api.checkForUpdates();
        expect(second.updateInfo).toBeNull();
    });

    test('a different version is still surfaced after skipping an older one', async () => {
        mockSkipStore = '1.2.3';
        mockCheck.mockResolvedValue({ updateAvailable: true, version: '1.3.0', downloadUrl: 'u' });

        const res = await api.checkForUpdates();
        expect(res.updateInfo).not.toBeNull();
        expect(res.updateInfo.latestVersion).toBe('1.3.0');
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
