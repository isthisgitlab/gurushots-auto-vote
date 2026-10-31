/**
 * The node platform family (Electron main, CLI, the web server): the fs
 * transport, the OS paths and the app's own file paths, the fs/SEA assets,
 * and the settings file lock. A shell's platform module builds this and
 * installs it; the family itself never calls installPlatform.
 *
 * The modules the family delegates to (runtime, appPaths, the logger's
 * context) are reached at call time, never at load: the Jest setup builds
 * and installs this family for every test file, and a module loaded there
 * would instantiate the setup's fs/path mocks before a test file registers
 * its own — with a cached mock winning over the later factory, the test's
 * re-mock would be dead. The logCleanup capability is a getter for the same
 * reason: building the platform must not load the logger's module graph.
 *
 * The members the node platforms have none of — the Capacitor HTTP adapter,
 * the native Android services — are null; the windows are no-ops (a desktop
 * has no windows to broadcast to from here).
 */

import { createNodeAssets } from './assets';
import { createNodePaths } from './paths';
import { createNodeStorage } from './store';
import { createNodeWipe } from './wipe';

import type { Platform } from '../../platform/port';

type ContextModule = typeof import('../../logger/context');

const context = (): ContextModule => require('../../logger/context') as ContextModule;

const createNodeHttp = (): Platform['http'] => ({ adapter: null });

const createNodeNative = (): Platform['native'] => ({
    autovote: null,
    foregroundService: null,
    apkInstaller: null,
});

const createNodeWindows = (): Platform['windows'] => ({
    broadcastSettingsChanged: () => undefined,
    afterWipe: () => undefined,
});

const createNodeCapabilities = (): Platform['capabilities'] => ({
    // The mission-needs refresh resolver is the headless cycle's; Snap plays
    // from the app, the desktop and the CLI; the scenarios are owned by the
    // native service, of which node has none; recovery names the file to
    // delete; the log context and the hourly cleanup are the logger's own
    // node answers.
    refreshMissionNeeds: false,
    snapAllowed: true,
    backgroundServiceOwnsScenarios: () => false,
    recoveryWording: 'file',
    logContext: (): 'CLI' | 'GUI' => (context().getContext() === 'GUI' ? 'GUI' : 'CLI'),
    get logCleanup(): boolean {
        const ctx = context();
        return ctx.isElectronApp || ctx.startedViaCli;
    },
});

const createNodePlatform = (): Platform => ({
    http: createNodeHttp(),
    storage: createNodeStorage(),
    paths: createNodePaths(),
    assets: createNodeAssets(),
    wipe: createNodeWipe(),
    native: createNodeNative(),
    windows: createNodeWindows(),
    capabilities: createNodeCapabilities(),
});

export { createNodePlatform };
