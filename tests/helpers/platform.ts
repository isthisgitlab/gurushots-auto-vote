/**
 * The node test platform and the installers every test swaps platforms
 * through (the port's install rules refuse a second, different install, so a
 * swap is reset + install). The test platform resolves paths.userData()
 * inside a fresh temporary directory — created with the real fs, because
 * tests/setup.ts mocks the fs module — never inside the real home, which the
 * guard in tests/setupPlatform.ts checks.
 *
 * Later slices add the webview and headless test installers beside these.
 */

import { createNodePlatform } from '../../src/ts/platforms/node';
import { installPlatform, resetPlatformForTests } from '../../src/ts/platform/port';

import type { Platform } from '../../src/ts/platform/port';

// The temporary directory the latest build resolved paths.userData() into; removed when the next build replaces it.
let lastUserDataDir: string | null = null;

/**
 * The node test platform: the node family, with paths.userData() resolving
 * into a fresh temporary directory.
 */
const buildNodeTestPlatform = (): Platform => {
    const realFs = jest.requireActual('node:fs') as typeof import('node:fs');
    const realOs = jest.requireActual('node:os') as typeof import('node:os');
    const realPath = jest.requireActual('node:path') as typeof import('node:path');
    if (lastUserDataDir !== null) realFs.rmSync(lastUserDataDir, { recursive: true, force: true });
    const dir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'gurushots-test-user-data-'));
    lastUserDataDir = dir;
    const base = createNodePlatform();
    // The paths member is replaced in place: spreading the whole platform
    // would read the logCleanup getter and load the logger's module graph,
    // which building the platform must not do (see platforms/node/index.ts).
    base.paths = { ...base.paths, userData: () => dir };
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

/** Clears the installed platform without reinstalling — for a test that needs the port empty. */
const clearInstalledPlatform = (): void => {
    resetPlatformForTests();
};

export { buildNodeTestPlatform, installTestPlatform, restoreNodeTestPlatform, clearInstalledPlatform };
