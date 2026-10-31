/**
 * The test platforms and the installers every test swaps platforms through
 * (the port's install rules refuse a second, different install, so a swap is
 * reset + install). The install contract holds in tests as in production —
 * installPlatform keeps refusing a different object — so a test that loads an
 * entry module calls clearInstalledPlatform() first, as the entry-importing
 * test files do. The node test platform resolves paths.userData() inside
 * one temporary directory per test file — created with the real fs, because
 * tests/setup.ts mocks the fs module — never inside the real home, which the
 * guard in tests/setupPlatform.ts checks; the setup file removes the
 * directory in its afterAll. The webview and headless platforms are their
 * families with the native parts a test wants passed in explicitly (nulls
 * where it wants none) and the no-op windows of a test run.
 */

import { createHeadlessPlatform } from '../../src/ts/platforms/headless';
import { createNodePlatform } from '../../src/ts/platforms/node';
import { createWebviewPlatform } from '../../src/ts/platforms/webview';
import { installPlatform, resetPlatformForTests } from '../../src/ts/platform/port';

import type { Platform, PlatformWindows } from '../../src/ts/platform/port';

// The temporary directory the node platform resolves paths.userData() into:
// created once per test file, removed by removeNodeTestUserDataDir (the setup
// file's afterAll). A call after the removal throws instead of creating a
// directory nothing would remove.
let userDataDir: string | null = null;
let userDataDirRemoved = false;

const nodeTestUserDataDir = (): string => {
    if (userDataDirRemoved) throw new Error('the test user-data directory was already removed');
    if (userDataDir === null) {
        const realFs = jest.requireActual('node:fs') as typeof import('node:fs');
        const realOs = jest.requireActual('node:os') as typeof import('node:os');
        const realPath = jest.requireActual('node:path') as typeof import('node:path');
        userDataDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'gurushots-test-user-data-'));
    }
    return userDataDir;
};

/** Removes the test file's temporary user-data directory, if one was created. */
const removeNodeTestUserDataDir = (): void => {
    if (userDataDir === null) return;
    (jest.requireActual('node:fs') as typeof import('node:fs')).rmSync(userDataDir, {
        recursive: true,
        force: true,
    });
    userDataDir = null;
    userDataDirRemoved = true;
};

// The test windows: nothing to broadcast to or relaunch from a test run — the
// explicit no-ops, as the CLI's and the headless service's shell modules pass
// them.
const testWindows: PlatformWindows = {
    broadcastSettingsChanged: () => undefined,
    afterWipe: () => undefined,
};

/**
 * The node test platform: the node family, with paths.userData() resolving
 * into the test file's temporary directory.
 */
const buildNodeTestPlatform = (): Platform => {
    const base = createNodePlatform(testWindows);
    // The paths member is replaced in place: spreading the whole platform
    // would read the logCleanup getter and load the logger's module graph,
    // which building the platform must not do (see platforms/node/index.ts).
    base.paths = { ...base.paths, userData: () => nodeTestUserDataDir() };
    return base;
};

/**
 * Installs the node test platform; `overrides` replaces members of the built
 * object, a member group whole (spread the built group to change one member).
 */
const installTestPlatform = (overrides?: Partial<Platform>): Platform => {
    resetPlatformForTests();
    // Object.assign writes the overrides without reading the members they replace.
    const installed = Object.assign(buildNodeTestPlatform(), overrides);
    installPlatform(installed);
    return installed;
};

/** Reinstalls the untouched node test platform — after a test swapped it. */
const restoreNodeTestPlatform = (): Platform => installTestPlatform();

/**
 * Installs the webview test platform, with the parts no test wants (nulls,
 * the no-op windows); `overrides` replaces members of the built object, a
 * member group whole (spread the built group to change one member).
 */
const installWebviewTestPlatform = (overrides?: Partial<Platform>): Platform => {
    resetPlatformForTests();
    // Object.assign writes the overrides without reading the members they replace.
    const installed = Object.assign(
        createWebviewPlatform({
            cas: null,
            nativeWipe: async () => null,
            native: { autovote: null, foregroundService: null, apkInstaller: null },
            windows: testWindows,
        }),
        overrides,
    );
    installPlatform(installed);
    return installed;
};

/** Installs the headless test platform, with the same `overrides` rule. */
const installHeadlessTestPlatform = (overrides?: Partial<Platform>): Platform => {
    resetPlatformForTests();
    const installed = Object.assign(createHeadlessPlatform(testWindows), overrides);
    installPlatform(installed);
    return installed;
};

/** Clears the installed platform without reinstalling — for a test that needs the port empty. */
const clearInstalledPlatform = (): void => {
    resetPlatformForTests();
};

export {
    buildNodeTestPlatform,
    installTestPlatform,
    restoreNodeTestPlatform,
    installWebviewTestPlatform,
    installHeadlessTestPlatform,
    clearInstalledPlatform,
    nodeTestUserDataDir,
    removeNodeTestUserDataDir,
};
