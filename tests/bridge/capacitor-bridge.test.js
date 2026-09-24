/**
 * Capacitor bridge — the window.api surface on Android. Covers the in-process
 * pub/sub, the GitHub-Releases update flow (check → download → install), the
 * send-style login/logout hints, and the mobile window-control fallbacks.
 * The ipc handler modules and update services are mocked so the bridge can be
 * installed without a WebView.
 */

let mockSettingsDeps = null;
jest.mock('../../src/js/ipc/settings.handlers', () => ({
    buildHandlers: (deps) => {
        mockSettingsDeps = deps;
        return { 'get-settings': jest.fn(async () => ({ theme: 'dark' })) };
    },
}));
jest.mock('../../src/js/ipc/voting.handlers', () => ({
    buildHandlers: () => ({ 'gui-vote': jest.fn(async (_event) => ({ success: true, via: 'gui-vote' })) }),
}));
jest.mock('../../src/js/ipc/log.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/actions.handlers', () => ({
    buildHandlers: () => ({ 'apply-boost-to-entry': jest.fn(async (_event, id) => ({ success: true, id })) }),
}));
jest.mock('../../src/js/ipc/computations.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/ipc/currency.handlers', () => ({ buildHandlers: () => ({}) }));
jest.mock('../../src/js/services/AndroidUpdateInstaller', () => ({ downloadAndInstall: jest.fn() }));
const mockHasBundledModel = jest.fn(async () => true);
jest.mock('../../src/js/services/visionVerifier', () => ({ hasBundledModel: mockHasBundledModel }));
jest.mock('../../src/js/services/UpdateChecker', () => ({
    checkForUpdates: jest.fn(),
    getReleasesUrl: () => 'https://example.com/releases',
}));
jest.mock('../../src/js/services/auth', () => ({ clearAuthToken: jest.fn() }));
jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    seedIntentProfiles: jest.fn(),
}));

const pkg = require('../../package.json');

describe('Capacitor bridge', () => {
    let api;
    let bridge;
    let settings;
    let updateChecker;
    let installer;
    let auth;
    let log;

    beforeEach(() => {
        delete globalThis.api;
        jest.resetModules();
        settings = require('../../src/js/settings');
        updateChecker = require('../../src/js/services/UpdateChecker');
        installer = require('../../src/js/services/AndroidUpdateInstaller');
        auth = require('../../src/js/services/auth');
        log = { error: jest.fn(), warning: jest.fn(), info: jest.fn(), debug: jest.fn() };
        require('../../src/js/logger').withCategory.mockReturnValue(log);
        bridge = require('../../src/js/bridge/capacitor');
        api = bridge.installBridge();
    });

    afterEach(() => {
        delete globalThis.api;
        delete globalThis.sendLogToGUI;
    });

    describe('installation', () => {
        test('exposes the api on globalThis and adapts (event, ...args) handlers to (...args)', async () => {
            expect(globalThis.api).toBe(api);
            expect(settings.seedIntentProfiles).toHaveBeenCalledTimes(1);
            await expect(api.getSettings()).resolves.toEqual({ theme: 'dark' });
            await expect(api.guiVote()).resolves.toEqual({ success: true, via: 'gui-vote' });
        });

        test('mirrors the manifest aliases onto their target channel methods', async () => {
            expect(api.applyBoost).toBe(api.applyBoostToEntry);
            await expect(api.applyBoost('e1')).resolves.toEqual({ success: true, id: 'e1' });
        });

        test('a failing intent-profile seed is logged but does not block installation', () => {
            settings.seedIntentProfiles.mockImplementationOnce(() => {
                throw new Error('prefs unavailable');
            });

            const second = bridge.installBridge();

            expect(typeof second.checkForUpdates).toBe('function');
            expect(log.warning).toHaveBeenCalledWith('Intent profile seeding failed (non-fatal):', expect.any(Error));
        });
    });

    describe('in-process pub/sub', () => {
        test('delivers to every subscriber, isolates a throwing one, and supports unsubscribe', () => {
            const bad = jest.fn(() => {
                throw new Error('listener bug');
            });
            const good = jest.fn();
            const unsubscribeBad = api.onUpdateChecking(bad);
            api.onUpdateChecking(good);

            bridge.emit('update-checking', 1);

            expect(bad).toHaveBeenCalledWith(1);
            expect(good).toHaveBeenCalledWith(1);
            expect(log.error).toHaveBeenCalledWith(
                'Capacitor bridge listener for update-checking threw',
                expect.any(Error),
            );

            unsubscribeBad();
            bridge.emit('update-checking', 2);
            expect(bad).toHaveBeenCalledTimes(1);
            expect(good).toHaveBeenLastCalledWith(2);
        });

        test('emitting on a channel nobody subscribed to is a no-op', () => {
            expect(() => bridge.emit('never-subscribed', {})).not.toThrow();
        });

        test('settings saves broadcast to onSettingsChanged subscribers', () => {
            const onChange = jest.fn();
            api.onSettingsChanged(onChange);

            mockSettingsDeps.broadcastSettingsChange({ language: 'lv' });

            expect(onChange).toHaveBeenCalledWith({ language: 'lv' });
        });

        test('logger fan-out reaches onLogMessage subscribers', () => {
            const onLog = jest.fn();
            api.onLogMessage(onLog);

            globalThis.sendLogToGUI({ level: 'info', message: 'hi' });

            expect(onLog).toHaveBeenCalledWith({ level: 'info', message: 'hi' });
        });
    });

    describe('update flow', () => {
        const available = {
            updateAvailable: true,
            version: '9.9.9',
            releaseNotes: 'notes',
            releaseDate: '2026-09-01',
            isPrerelease: false,
            downloadUrl: 'https://example.com/app.apk',
        };

        test('check-for-updates asks for the APK asset on the right channel and announces the update', async () => {
            updateChecker.checkForUpdates.mockResolvedValue(available);
            const onAvailable = jest.fn();
            api.onUpdateAvailable(onAvailable);

            const res = await api.checkForUpdates();

            expect(updateChecker.checkForUpdates).toHaveBeenCalledWith({
                currentVersion: pkg.version,
                isBetaChannel: pkg.version.includes('-'),
                assetSuffix: '.apk',
            });
            const updateInfo = {
                currentVersion: pkg.version,
                latestVersion: '9.9.9',
                releaseNotes: 'notes',
                releaseDate: '2026-09-01',
                isPrerelease: false,
                downloadUrl: 'https://example.com/app.apk',
            };
            expect(res).toEqual({ success: true, updateInfo });
            expect(onAvailable).toHaveBeenCalledWith(updateInfo);
        });

        test('a lite build (no bundled vision model) asks for the lite APK', async () => {
            mockHasBundledModel.mockResolvedValueOnce(false);
            updateChecker.checkForUpdates.mockResolvedValue(available);

            await api.checkForUpdates();

            expect(updateChecker.checkForUpdates).toHaveBeenCalledWith(
                expect.objectContaining({ assetSuffix: '-lite.apk' }),
            );
        });

        test('check-for-updates reports "not available" with the remote version, or our own when unknown', async () => {
            const onNotAvailable = jest.fn();
            api.onUpdateNotAvailable(onNotAvailable);

            updateChecker.checkForUpdates.mockResolvedValueOnce({ updateAvailable: false, version: '1.0.0' });
            await expect(api.checkForUpdates()).resolves.toEqual({ success: true, updateInfo: null });
            expect(onNotAvailable).toHaveBeenLastCalledWith({ version: '1.0.0' });

            updateChecker.checkForUpdates.mockResolvedValueOnce({ updateAvailable: false, version: null });
            await api.checkForUpdates();
            expect(onNotAvailable).toHaveBeenLastCalledWith({ version: pkg.version });
        });

        test('check-for-updates turns a thrown error into update-error with a browser fallback', async () => {
            updateChecker.checkForUpdates.mockRejectedValue(new Error('rate limited'));
            const onError = jest.fn();
            api.onUpdateError(onError);

            await expect(api.checkForUpdates()).resolves.toEqual({ success: false, error: 'rate limited' });
            expect(onError).toHaveBeenCalledWith({ message: 'rate limited', canFallbackToBrowser: true });
        });

        test('download-update without a prior check points the user at the releases page', async () => {
            await expect(api.downloadUpdate()).resolves.toEqual({
                success: false,
                error: 'No update info — run check-for-updates first',
                fallbackUrl: 'https://example.com/releases',
            });
            expect(installer.downloadAndInstall).not.toHaveBeenCalled();
        });

        test('download-update installs the cached APK, forwards progress and announces completion', async () => {
            updateChecker.checkForUpdates.mockResolvedValue(available);
            await api.checkForUpdates();
            installer.downloadAndInstall.mockImplementation(async ({ onProgress }) => {
                onProgress({ percent: 50 });
                return { success: true, version: '9.9.9' };
            });
            const onProgress = jest.fn();
            const onDownloaded = jest.fn();
            api.onDownloadProgress(onProgress);
            api.onUpdateDownloaded(onDownloaded);

            const res = await api.downloadUpdate();

            expect(installer.downloadAndInstall).toHaveBeenCalledWith({
                downloadUrl: 'https://example.com/app.apk',
                version: '9.9.9',
                onProgress: expect.any(Function),
            });
            expect(onProgress).toHaveBeenCalledWith({ percent: 50 });
            expect(onDownloaded).toHaveBeenCalledWith(expect.objectContaining({ latestVersion: '9.9.9' }));
            expect(res).toEqual({ success: true, version: '9.9.9', fallbackUrl: 'https://example.com/releases' });
        });

        test('a failed install surfaces update-error and still returns the fallback url', async () => {
            updateChecker.checkForUpdates.mockResolvedValue(available);
            await api.checkForUpdates();
            installer.downloadAndInstall.mockResolvedValue({ success: false, error: 'No mechanism' });
            const onError = jest.fn();
            api.onUpdateError(onError);

            const res = await api.downloadUpdate();

            expect(onError).toHaveBeenCalledWith({ message: 'No mechanism', canFallbackToBrowser: true });
            expect(res).toEqual({ success: false, error: 'No mechanism', fallbackUrl: 'https://example.com/releases' });
        });

        test('install-update, get-releases-url and can-auto-update return their fixed answers', async () => {
            await expect(api.installUpdate()).resolves.toMatchObject({ success: true, info: expect.any(String) });
            await expect(api.getReleasesUrl()).resolves.toEqual({
                success: true,
                url: 'https://example.com/releases',
            });
            await expect(api.canAutoUpdate()).resolves.toEqual({ success: true, canAutoUpdate: true });
        });
    });

    describe('login / logout hints', () => {
        test('login emits the login-success event', () => {
            const onLogin = jest.fn();
            bridge.subscribe('login-success', onLogin);

            api.login();

            expect(onLogin).toHaveBeenCalledTimes(1);
        });

        test('logout clears the token before emitting', async () => {
            const onLogout = jest.fn();
            bridge.subscribe('logout', onLogout);
            auth.clearAuthToken.mockResolvedValue(undefined);

            await api.logout();

            expect(auth.clearAuthToken).toHaveBeenCalled();
            expect(onLogout).toHaveBeenCalledTimes(1);
        });

        test('logout still emits when clearing the token fails', async () => {
            const onLogout = jest.fn();
            bridge.subscribe('logout', onLogout);
            auth.clearAuthToken.mockRejectedValue(new Error('prefs write failed'));

            await api.logout();

            expect(log.error).toHaveBeenCalledWith('Logout failed to clear token', expect.any(Error));
            expect(onLogout).toHaveBeenCalledTimes(1);
        });
    });

    describe('window controls', () => {
        let originalLocation;
        let originalOpen;
        let originalCapacitor;

        beforeEach(() => {
            originalLocation = globalThis.location;
            originalOpen = globalThis.open;
            originalCapacitor = globalThis.Capacitor;
        });

        afterEach(() => {
            globalThis.location = originalLocation;
            globalThis.open = originalOpen;
            globalThis.Capacitor = originalCapacitor;
        });

        test('reloadWindow reloads the WebView when possible and always resolves success', async () => {
            const reload = jest.fn();
            globalThis.location = { reload };
            await expect(api.reloadWindow()).resolves.toEqual({ success: true });
            expect(reload).toHaveBeenCalled();

            globalThis.location = undefined;
            await expect(api.reloadWindow()).resolves.toEqual({ success: true });
        });

        test('refreshMenu is a successful no-op on mobile', async () => {
            await expect(api.refreshMenu()).resolves.toEqual({ success: true });
        });

        test('openExternalUrl refuses non-https schemes', async () => {
            globalThis.open = jest.fn();

            await expect(api.openExternalUrl('intent://evil')).resolves.toEqual({
                success: false,
                error: 'Only https:// URLs can be opened',
            });
            expect(globalThis.open).not.toHaveBeenCalled();
            expect(log.warning).toHaveBeenCalledWith('Refused openExternalUrl for non-https URL: intent://evil', null);
        });

        test('openExternalUrl prefers the native Browser plugin', async () => {
            const open = jest.fn().mockResolvedValue('opened');
            globalThis.Capacitor = { Plugins: { Browser: { open } } };

            await expect(api.openExternalUrl('https://gurushots.com')).resolves.toBe('opened');
            expect(open).toHaveBeenCalledWith({ url: 'https://gurushots.com' });
        });

        test('openExternalUrl falls back to window.open when the plugin lookup throws', async () => {
            globalThis.Capacitor = {
                get Plugins() {
                    throw new Error('bridge not ready');
                },
            };
            globalThis.open = jest.fn();

            await expect(api.openExternalUrl('https://gurushots.com')).resolves.toEqual({ success: true });
            expect(globalThis.open).toHaveBeenCalledWith('https://gurushots.com', '_blank');
        });

        test('openExternalUrl still resolves when there is no way to open anything', async () => {
            globalThis.Capacitor = undefined;
            globalThis.open = undefined;

            await expect(api.openExternalUrl('https://gurushots.com')).resolves.toEqual({ success: true });
        });
    });
});
