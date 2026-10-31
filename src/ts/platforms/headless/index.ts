/**
 * The headless platform family: the Android background service (a bare
 * WebView driven by the native AutoVoteService, `__GS_HEADLESS__` set, no
 * Capacitor runtime). The AndroidHeadlessStore bridge storage, the
 * AndroidHeadlessHttp adapter, the fetch assets, and the capabilities of a
 * service that runs one voting cycle per alarm. A shell's platform module
 * builds this and installs it; the family itself never calls installPlatform.
 *
 * The service is itself the native side: the native members are null, and
 * nothing else is passed in. Its shell module passes the windows — the
 * explicit no-ops of a service with no windows to reach — as it does for
 * every shell. The modules the family delegates to are reached at call time,
 * never at load: the node project's setup file loads the test helpers that
 * import this family, so a module graph loaded at import time would land in
 * the setup's registry before a test file registers its own mocks, and the
 * test's factory would lose to the cached module (platforms/node/index.ts
 * states the reason in full). It also keeps building the platform free of
 * module graphs.
 */

import { createHeadlessAssets } from './assets';
import { createHeadlessPaths } from './paths';
import { createHeadlessStorage } from './store';
import { createHeadlessWipe } from './wipe';

import type { Platform, PlatformWindows } from '../../platform/port';

type ApiClientModule = typeof import('../../api/api-client');

const apiClient = (): ApiClientModule => require('../../api/api-client') as ApiClientModule;

const createHeadlessCapabilities = (): Platform['capabilities'] => ({
    // The headless cycle has no pass-scoped fetch, so the pass builds the
    // mission-needs refresh resolver; Snap is skipped here (the cycle is
    // capped, and Snap plays from the app); recovery names the store to
    // clear; and the log context and the hourly cleanup are the logger's
    // WebView answers (logger/context answers CLI without Electron;
    // logger/files arms the interval only for Electron or a CLI start).
    refreshMissionNeeds: true,
    snapAllowed: false,
    // The service runs no scenarios of the app's: the native side it drives is
    // itself (the rule of services/scenarioRunner/step answers false without
    // the Capacitor runtime).
    backgroundServiceOwnsScenarios: () => false,
    recoveryWording: 'store',
    logContext: () => 'CLI',
    logCleanup: false,
});

/**
 * The headless platform; `windows` is the shell's (the explicit no-ops of a
 * service with no windows — the headless shell module passes them).
 */
const createHeadlessPlatform = (windows: PlatformWindows): Platform => ({
    // The AndroidHeadlessHttp adapter of api-client.ts, resolved on read so
    // building the platform loads no module graph.
    http: {
        get adapter() {
            return apiClient().getHeadlessHttpAdapter();
        },
    },
    storage: createHeadlessStorage(),
    paths: createHeadlessPaths(),
    assets: createHeadlessAssets(),
    wipe: createHeadlessWipe(),
    native: { autovote: null, foregroundService: null, apkInstaller: null },
    windows,
    capabilities: createHeadlessCapabilities(),
});

export { createHeadlessPlatform };
