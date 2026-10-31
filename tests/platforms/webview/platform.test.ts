/**
 * The webview family as a whole: the platform createWebviewPlatform builds,
 * with the parts the shell module passes in beside the defaults. The adapter
 * builder and the scenario rule are mocked at their core modules, the plugin
 * at settings/capacitorPreferences.
 */

const mockAdapter = jest.fn<AxiosPromise, []>();

jest.mock('../../../src/ts/api/api-client', () => ({
    __esModule: true,
    getCapacitorHttpAdapter: jest.fn((): AxiosAdapter => mockAdapter),
}));

const mockOwnsScenarios = jest.fn<boolean, []>();

jest.mock('../../../src/ts/services/scenarioRunner/step', () => ({
    __esModule: true,
    backgroundServiceOwnsScenarios: () => mockOwnsScenarios(),
}));

const mockValues = new Map<string, string>();
const mockPlugin = {
    get: jest.fn(async ({ key }: { key: string }) => ({ value: mockValues.get(key) ?? null })),
    set: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    keys: jest.fn(async () => ({ keys: [...mockValues.keys()] })),
};

jest.mock('../../../src/ts/settings/capacitorPreferences', () => ({
    __esModule: true,
    getCapacitorPreferences: () => mockPlugin,
    listPreferenceKeys: jest.fn(async () => [...mockValues.keys()]),
    removePreferenceKeys: jest.fn(async () => undefined),
}));

import { installWebviewTestPlatform } from '../../helpers/platform';
import { platform } from '../../../src/ts/platform/port';
import { createWebviewPlatform } from '../../../src/ts/platforms/webview';

import type { AxiosAdapter, AxiosPromise } from 'axios';
import type { CasAnswer } from '../../../src/ts/settings/storeTransport';
import type { PlatformNative } from '../../../src/ts/platform/port';

const apiClient = jest.mocked(
    require('../../../src/ts/api/api-client') as typeof import('../../../src/ts/api/api-client'),
);

describe('the webview platform', () => {
    test('the adapter is the CapacitorHttp one, resolved on read', () => {
        const p = createWebviewPlatform();
        expect(p.http.adapter).toBe(mockAdapter);
        expect(apiClient.getCapacitorHttpAdapter).toHaveBeenCalled();
    });

    test('the native members are null until the shell passes them', () => {
        expect(createWebviewPlatform().native).toEqual({
            autovote: null,
            foregroundService: null,
            apkInstaller: null,
        });
    });

    test('the native compare-and-write and the native wipe arrive through the parts', () => {
        const cas = jest.fn<Promise<CasAnswer> | null, [string, string | null, string]>();
        const nativeWipe = jest.fn<Promise<{ ok: boolean } | null>, []>();
        const native: PlatformNative = { autovote: null, foregroundService: null, apkInstaller: null };
        const p = createWebviewPlatform({ cas, nativeWipe, native });
        expect(p.storage.cas).toBe(cas);
        expect(p.wipe.nativeWipe).toBe(nativeWipe);
        expect(p.native).toBe(native);
    });

    test('there are no windows to reach, and the wipe is the Capacitor one', async () => {
        const p = createWebviewPlatform();
        expect(p.windows).toBeNull();
        expect(p.wipe.clearSession).toBeNull();
        expect(p.wipe.reloadAfterWipe).toBe(true);
        await expect(p.wipe.nativeWipe()).resolves.toBeNull();
        await expect(p.wipe.listPreferenceKeys?.()).resolves.toEqual([]);
        await expect(p.wipe.removePreferenceKeys?.(['gs_k'])).resolves.toBeUndefined();
    });

    test('the capabilities name the app WebView answers', () => {
        const c = createWebviewPlatform().capabilities;
        expect(c.refreshMissionNeeds).toBe(false);
        expect(c.snapAllowed).toBe(true);
        expect(c.recoveryWording).toBe('store');
        expect(c.logContext()).toBe('CLI');
        expect(c.logCleanup).toBe(false);
    });

    test('backgroundServiceOwnsScenarios is the scenario rule the branch answers today', () => {
        mockOwnsScenarios.mockReturnValue(true);
        expect(createWebviewPlatform().capabilities.backgroundServiceOwnsScenarios()).toBe(true);
        expect(mockOwnsScenarios).toHaveBeenCalled();
    });
});

describe('the webview test installer', () => {
    test('it installs the family, and overrides replace a member group whole', () => {
        const installed = installWebviewTestPlatform({
            windows: { broadcastSettingsChanged: () => undefined, afterWipe: () => undefined },
        });
        expect(platform()).toBe(installed);
        expect(installed.windows).not.toBeNull();
    });

    test('a plain install puts the family on the port', () => {
        const installed = installWebviewTestPlatform();
        expect(platform()).toBe(installed);
        expect(installed.http.adapter).toBe(mockAdapter);
    });
});
