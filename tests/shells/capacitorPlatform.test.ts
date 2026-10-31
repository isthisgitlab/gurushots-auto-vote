/**
 * The Capacitor page's platform module: it installs the webview family with
 * the shell's plugin-backed parts when it loads. The family is mocked to
 * record the parts the module passes, so the parts are checked directly —
 * the installed storage is a throwing stub until Phase 3 step 7, so nothing
 * reaches it through the installed platform. The bridge is mocked; the
 * native services and the wipe are real: the parts must be the plugin-backed
 * code, and the plugin is a stub on the Capacitor global. The installed
 * object is captured once: the setup file's afterEach reinstalls the node
 * test platform on the port, so the tests read the captured object, not the
 * slot.
 */

import { platform } from '../../src/ts/platform/port';
import type { createWebviewPlatform } from '../../src/ts/platforms/webview';
import { clearInstalledPlatform } from '../helpers/platform';

import type { CapacitorGlobals } from '../../src/ts/types/capacitor';
import type { Platform } from '../../src/ts/platform/port';

type WebviewParts = Parameters<typeof createWebviewPlatform>[0];

jest.mock('../../src/ts/bridge/capacitor', () => ({
    __esModule: true,
    emit: jest.fn<void, [string, unknown]>(),
    reloadWindow: jest.fn(async (): Promise<{ success: boolean }> => ({ success: true })),
}));

jest.mock('../../src/ts/platforms/webview', () => {
    const real = jest.requireActual<typeof import('../../src/ts/platforms/webview')>('../../src/ts/platforms/webview');
    const recorded: { parts: WebviewParts | null } = { parts: null };
    const createWebviewPlatform = (parts: WebviewParts) => {
        recorded.parts = parts;
        return real.createWebviewPlatform(parts);
    };
    return { __esModule: true, createWebviewPlatform, __recorded: recorded };
});

// One plugin instance for the whole file: the bridge caches the plugin it
// finds, so a per-test replacement would not be the one it reads.
const plugin = {
    start: jest.fn(),
    stop: jest.fn(),
    getStatus: jest.fn(),
    compareAndWrite: jest.fn(
        async (): Promise<{ saved: boolean; current: string | null }> => ({
            saved: true,
            current: null,
        }),
    ),
    wipeLocalData: jest.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
};

const capacitorGlobals = globalThis as CapacitorGlobals;
let savedCapacitor: CapacitorGlobals['Capacitor'];

beforeAll(() => {
    savedCapacitor = capacitorGlobals.Capacitor;
    capacitorGlobals.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: plugin } };
});

afterAll(() => {
    capacitorGlobals.Capacitor = savedCapacitor;
});

// Requiring the module installs the platform and records the parts it
// passes; the slot is cleared first, because the setup file installed the
// node test platform before this file loaded.
clearInstalledPlatform();
require('../../src/ts/bridge/capacitorPlatform');
const installed: Platform = platform();

const webview = require('../../src/ts/platforms/webview') as {
    __recorded: { parts: WebviewParts | null };
};
const parts = webview.__recorded.parts as WebviewParts;

// The modules the shell members wrap, reached at call time — the install
// must run before the logger loads (whose own absence from the chain the
// bundle check proves). The native wipe is the shell's own body now (the
// plugin global is read at call time), so only the bridge and the native
// services are wrapped modules. The deferral suite stands FIRST: a
// jest.doMock inside isolateModules only wins while the wrapped module has
// not been instantiated in the outer registry (the tests below instantiate
// the file-level bridge mock), and its afterEach re-registers that mock.
const HEAVY = [
    '../../src/ts/bridge/capacitor',
    '../../src/ts/services/NativeAutovoteBridge',
    '../../src/ts/services/ForegroundServiceController',
    '../../src/ts/services/AndroidUpdateInstaller',
];

describe('loading the Capacitor shell platform module defers the wrapped modules', () => {
    let mockLoaded: string[];

    beforeEach(() => {
        mockLoaded = [];
    });

    afterEach(() => {
        for (const heavy of HEAVY) jest.dontMock(heavy);
        // doMock (not mock): the hoisted registration was removed by
        // dontMock above, and a runtime re-registration is a doMock.
        jest.doMock('../../src/ts/bridge/capacitor', () => ({
            __esModule: true,
            emit: jest.fn<void, [string, unknown]>(),
            reloadWindow: jest.fn(async (): Promise<{ success: boolean }> => ({ success: true })),
        }));
    });

    test('loading installs the platform and loads none of them', () => {
        jest.isolateModules(() => {
            clearInstalledPlatform();
            for (const heavy of HEAVY) {
                jest.doMock(heavy, () => {
                    mockLoaded.push(heavy);
                    return {};
                });
            }
            require('../../src/ts/bridge/capacitorPlatform');
            expect(mockLoaded).toEqual([]);
            expect(platform()).toBeDefined();
        });
    });

    test('calling a member reaches the module it wraps', () => {
        jest.isolateModules(() => {
            clearInstalledPlatform();
            jest.doMock('../../src/ts/bridge/capacitor', () => ({
                __esModule: true,
                emit: jest.fn<void, [string, unknown]>(),
                reloadWindow: jest.fn(async (): Promise<{ success: boolean }> => ({ success: true })),
            }));
            jest.doMock('../../src/ts/services/NativeAutovoteBridge', () => ({
                __esModule: true,
                isAvailable: () => true,
            }));
            require('../../src/ts/bridge/capacitorPlatform');
            // The deferred require of each wrapped module is the next thing
            // these members run, so each call lands in the doMock'ed module;
            // the native wipe is the shell's own body, reading the plugin
            // global at call time.
            const bridgeMock = require('../../src/ts/bridge/capacitor') as {
                emit: jest.Mock<void, [string, unknown]>;
                reloadWindow: jest.Mock<Promise<{ success: boolean }>, []>;
            };
            plugin.wipeLocalData.mockClear();
            void platform().wipe.nativeWipe();
            expect(plugin.wipeLocalData).toHaveBeenCalledTimes(1);
            expect(platform().capabilities.backgroundServiceOwnsScenarios()).toBe(true);
            platform().windows.broadcastSettingsChanged({});
            expect(bridgeMock.emit).toHaveBeenCalledWith('settings-changed', {});
            void platform().windows.afterWipe();
            expect(bridgeMock.reloadWindow).toHaveBeenCalledTimes(1);
        });
    });
});

describe('the Capacitor shell platform module', () => {
    test('the module installs the platform the family builds with the recorded parts', () => {
        expect(parts).not.toBeNull();
        expect(installed).toBeDefined();
    });

    test('every part is present, and the native members are the real services', () => {
        expect(parts.cas).not.toBeNull();
        expect(parts.nativeWipe).not.toBeNull();
        expect(parts.native.autovote).toBe(require('../../src/ts/services/NativeAutovoteBridge'));
        expect(parts.native.foregroundService).toBe(require('../../src/ts/services/ForegroundServiceController'));
        expect(parts.native.apkInstaller).toBe(require('../../src/ts/services/AndroidUpdateInstaller'));
        expect(parts.windows).toBeDefined();
    });

    test('the compare-and-write goes through the plugin', async () => {
        await expect(parts.cas?.('gs_key', null, 'VALUE')).resolves.toEqual({ saved: true, current: null });
        expect(plugin.compareAndWrite).toHaveBeenCalledWith({ key: 'gs_key', expected: null, value: 'VALUE' });
    });

    test('the native wipe goes through the plugin', async () => {
        await expect(parts.nativeWipe()).resolves.toEqual({ ok: true });
        expect(plugin.wipeLocalData).toHaveBeenCalledTimes(1);
    });

    test('the windows are the bridge emit and the reload', () => {
        const capacitorBridge = jest.mocked(
            require('../../src/ts/bridge/capacitor') as typeof import('../../src/ts/bridge/capacitor'),
        );
        const settings = { theme: 'dark' };
        installed.windows.broadcastSettingsChanged(settings);
        expect(capacitorBridge.emit).toHaveBeenCalledWith('settings-changed', settings);
        installed.windows.afterWipe();
        expect(capacitorBridge.reloadWindow).toHaveBeenCalledTimes(1);
    });

    test('the installed capability answers through the plugin-backed native part', () => {
        expect(installed.capabilities.backgroundServiceOwnsScenarios()).toBe(true);
    });
});
