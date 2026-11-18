/**
 * The webview family as a whole: the platform createWebviewPlatform builds
 * with the parts the shell passes in — every part required. The adapter
 * builder is mocked at its family http module, the plugin module at
 * settings/capacitorPreferences; the scenario rule is computed from the
 * native part the shell passes.
 */

const mockAdapter = jest.fn<AxiosPromise, []>();

jest.mock('../../../src/ts/platforms/webview/http', () => ({
    __esModule: true,
    getCapacitorHttpAdapter: jest.fn((): AxiosAdapter => mockAdapter),
}));

const mockValues = new Map<string, string>();
const mockPlugin = {
    get: jest.fn(async ({ key }: { key: string }) => ({ value: mockValues.get(key) ?? null })),
    set: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    keys: jest.fn(async () => ({ keys: [...mockValues.keys()] })),
};
const mockListPreferenceKeys = jest.fn(async () => [...mockValues.keys()]);
const mockRemovePreferenceKeys = jest.fn(async () => undefined);

jest.mock('../../../src/ts/platforms/webview/capacitorPreferences', () => ({
    __esModule: true,
    getCapacitorPreferences: () => mockPlugin,
    listPreferenceKeys: () => mockListPreferenceKeys(),
    removePreferenceKeys: mockRemovePreferenceKeys,
}));

import { installWebviewTestPlatform } from '../../helpers/platform';
import { invalid } from '../../helpers/invalid';
import { platform } from '../../../src/ts/core/platform/port';
import { createWebviewPlatform } from '../../../src/ts/platforms/webview';

import type { AxiosAdapter, AxiosPromise } from 'axios';
import type { PlatformNative } from '../../../src/ts/core/platform/port';

const webviewHttp = jest.mocked(
    require('../../../src/ts/platforms/webview/http') as typeof import('../../../src/ts/platforms/webview/http'),
);

type WebviewParts = Parameters<typeof createWebviewPlatform>[0];

const NO_NATIVE: PlatformNative = {
    autovote: null,
    foregroundService: null,
    apkInstaller: null,
    readScenarioHostStatus: async () => ({ supported: false }),
};
const NO_WINDOWS = {
    broadcastSettingsChanged: () => undefined,
    broadcastEvent: () => undefined,
    afterWipe: () => undefined,
};

// The parts a test passes where it wants none of the shell's members: nulls,
// and the no-op windows of a test run.
const parts = (over: Partial<WebviewParts> = {}): WebviewParts => ({
    cas: null,
    nativeWipe: async () => null,
    native: NO_NATIVE,
    windows: NO_WINDOWS,
    ...over,
});

beforeEach(() => {
    mockValues.clear();
});

describe('the webview platform', () => {
    test('the adapter is the CapacitorHttp one, resolved on read', () => {
        const p = createWebviewPlatform(parts());
        expect(p.http.adapter).toBe(mockAdapter);
        expect(webviewHttp.getCapacitorHttpAdapter).toHaveBeenCalled();
    });

    test('the native members are the nulls the parts pass, and the wipe finds no plugin', async () => {
        const p = createWebviewPlatform(parts());
        expect(p.native).toEqual({
            autovote: null,
            foregroundService: null,
            apkInstaller: null,
            readScenarioHostStatus: expect.any(Function),
        });
        await expect(p.wipe.nativeWipe()).resolves.toBeNull();
    });

    test('the native wipe, the native services and the windows arrive through the parts', () => {
        const nativeWipe = jest.fn<Promise<{ ok: boolean } | null>, []>();
        const native = NO_NATIVE;
        const windows = NO_WINDOWS;
        const p = createWebviewPlatform(parts({ nativeWipe, native, windows }));
        expect(p.wipe.nativeWipe).toBe(nativeWipe);
        expect(p.native).toBe(native);
        expect(p.windows).toBe(windows);
    });

    test('the background service owns the scenarios while its plugin answers, and not without it', () => {
        const available = invalid<PlatformNative>({
            autovote: { isAvailable: () => true },
            foregroundService: null,
            apkInstaller: null,
        });
        const refusing = invalid<PlatformNative>({
            autovote: { isAvailable: () => false },
            foregroundService: null,
            apkInstaller: null,
        });
        expect(createWebviewPlatform(parts({ native: available })).capabilities.backgroundServiceOwnsScenarios()).toBe(
            true,
        );
        expect(createWebviewPlatform(parts({ native: refusing })).capabilities.backgroundServiceOwnsScenarios()).toBe(
            false,
        );
        expect(createWebviewPlatform(parts()).capabilities.backgroundServiceOwnsScenarios()).toBe(false);
    });

    test('there are windows to reach, and the wipe empties the keys through the plugin module', async () => {
        const p = createWebviewPlatform(parts());
        expect(typeof p.windows.broadcastSettingsChanged).toBe('function');
        expect(p.wipe.clearSession).toBeNull();
        expect(p.wipe.reloadAfterWipe).toBe(true);
        mockValues.set('gs_kept', 'VALUE');
        await expect(p.wipe.listPreferenceKeys?.()).resolves.toEqual(['gs_kept']);
        await expect(p.wipe.removePreferenceKeys?.(['gs_k'])).resolves.toBeUndefined();
        expect(mockRemovePreferenceKeys).toHaveBeenCalledWith(['gs_k']);
    });

    test('no user-data markers exist on a WebView: the desktop processes that hold them never run here', async () => {
        const wipe = createWebviewPlatform(parts()).wipe;
        await expect(wipe.markers.isCliSessionActive()).resolves.toBe(false);
        await expect(wipe.markers.isDesktopAppActive()).resolves.toBe(false);
        await expect(wipe.markers.isWebServerActive()).resolves.toBe(false);
        expect(wipe.markers.isMarkerFile('cli-session-1.lock')).toBe(false);
    });

    test('the capabilities name the app WebView answers', () => {
        const c = createWebviewPlatform(parts()).capabilities;
        expect(c.executor).toBe('android-app');
        expect(c.refreshMissionNeeds).toBe(false);
        expect(c.snapAllowed).toBe(true);
        expect(c.recoveryWording).toBe('store');
        expect(c.logContext()).toBe('CLI');
        expect(c.logCleanup).toBe(false);
    });
});

describe('the webview test installer', () => {
    test('it installs the family with the null parts, and overrides replace a member group whole', () => {
        const installed = installWebviewTestPlatform({ windows: NO_WINDOWS });
        expect(platform()).toBe(installed);
        expect(installed.native).toEqual({
            autovote: null,
            foregroundService: null,
            apkInstaller: null,
            readScenarioHostStatus: expect.any(Function),
        });
    });

    test('a plain install puts the family on the port', () => {
        const installed = installWebviewTestPlatform();
        expect(platform()).toBe(installed);
        expect(installed.http.adapter).toBe(mockAdapter);
    });
});
