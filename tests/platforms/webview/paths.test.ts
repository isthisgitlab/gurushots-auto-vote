/**
 * The webview family's paths member: the stub paths of a WebView, the answers
 * runtime.ts gave on a Capacitor page — `/<appName>` (no fs behind them;
 * writers fail-soft), isPackaged from the Capacitor global's isNativePlatform,
 * source detection always true. The app name comes through the core app
 * identity, so the family's isSourceCode answer drives it; the app-root
 * members throw — the family invents no app-root path.
 */

import { createWebviewPaths } from '../../../src/ts/platforms/webview/paths';
import { installWebviewTestPlatform } from '../../helpers/platform';

import type * as appIdentityModule from '../../../src/ts/core/platform/appIdentity';

const g = globalThis as typeof globalThis & { Capacitor?: unknown };

const capacitor = (native = true) => ({
    isNativePlatform: () => native,
    getPlatform: () => 'android',
});

afterEach(() => {
    delete g.Capacitor;
});

describe('the WebView stub paths', () => {
    test('userData is /<appName>, the dev name the family itself reports', () => {
        installWebviewTestPlatform();
        const { getAppName } = require('../../../src/ts/core/platform/appIdentity') as typeof appIdentityModule;
        expect(createWebviewPaths().userData()).toBe(`/${getAppName()}`);
        expect(createWebviewPaths().userData()).toBe('/gurushots-auto-vote-dev');
    });

    test('getUserDataDir stubs every app name', () => {
        expect(createWebviewPaths().getUserDataDir('gurushots-auto-vote')).toBe('/gurushots-auto-vote');
    });

    test('isPackaged reads the Capacitor global only when isNativePlatform is a function', () => {
        expect(createWebviewPaths().isPackaged()).toBe(false);
        g.Capacitor = {};
        expect(createWebviewPaths().isPackaged()).toBe(false);
        g.Capacitor = capacitor();
        expect(createWebviewPaths().isPackaged()).toBe(true);
        g.Capacitor = capacitor(false);
        expect(createWebviewPaths().isPackaged()).toBe(false);
    });

    test('isSourceCode is always true', () => {
        expect(createWebviewPaths().isSourceCode()).toBe(true);
    });
});

describe('the app-root members', () => {
    test('resourcesPath and appPath throw: no WebView code resolves a path below an app root', () => {
        const paths = createWebviewPaths();
        expect(() => paths.resourcesPath()).toThrow('webview has no app-root path');
        expect(() => paths.appPath('src', 'assets')).toThrow('webview has no app-root path');
    });
});
