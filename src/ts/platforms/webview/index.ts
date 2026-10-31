/**
 * The webview platform family: the app WebView (the Capacitor page's Android
 * UI). The Preferences write-behind storage, the CapacitorHttp adapter, the
 * fetch assets, the stub paths, and the wipe that empties the Preferences
 * keys and asks for a reload. A shell's platform module builds this and
 * installs it; the family itself never calls installPlatform.
 *
 * The members that need the shell's own code are left empty here and passed
 * in through `parts`: the native compare-and-write and the native services
 * call services/NativeAutovoteBridge.ts and its siblings (shell modules a
 * family cannot import), and the native wipe calls the AutoVoteBackground
 * plugin. There are no windows to reach from the WebView, so windows is null.
 *
 * The modules the family delegates to are reached at call time, never at
 * load: the node project's setup file loads the test helpers that import
 * this family, so a module graph loaded at import time would land in the
 * setup's registry before a test file registers its own mocks, and the
 * test's factory would lose to the cached module (platforms/node/index.ts
 * states the reason in full). It also keeps building the platform free of
 * module graphs.
 */

import { createWebviewAssets } from './assets';
import { createWebviewPaths } from './paths';
import { createWebviewStorage } from './store';
import { createWebviewWipe } from './wipe';

import type { Platform, PlatformCas, PlatformNative, PlatformWipe } from '../../platform/port';

/** The parts the shell module passes in: the native members a family cannot build. */
type WebviewNativeParts = {
    /** The native compare-and-write of one Preferences key (NativeAutovoteBridge compareAndWrite). */
    cas?: PlatformCas;
    /** The native plugin's wipe (AutoVoteBackground wipeLocalData). */
    nativeWipe?: PlatformWipe['nativeWipe'];
    /** The native services (the bridges and controllers the WebView page drives). */
    native?: PlatformNative;
};

type ApiClientModule = typeof import('../../api/api-client');
type StepModule = typeof import('../../services/scenarioRunner/step');

const apiClient = (): ApiClientModule => require('../../api/api-client') as ApiClientModule;
const step = (): StepModule => require('../../services/scenarioRunner/step') as StepModule;

const createWebviewCapabilities = (): Platform['capabilities'] => ({
    // The mission-needs refresh resolver is the headless cycle's; Snap plays
    // from the app; recovery names the store to clear; and the log context and
    // the hourly cleanup are the logger's WebView answers (logger/context
    // answers CLI without Electron; logger/files arms the interval only for
    // Electron or a CLI start).
    refreshMissionNeeds: false,
    snapAllowed: true,
    // The rule the branch answers today (services/scenarioRunner/step): the
    // native background service owns the scenarios while the app WebView has
    // its bridge. Reached at call time — the bridge it asks for is shell code.
    backgroundServiceOwnsScenarios: () => step().backgroundServiceOwnsScenarios(),
    recoveryWording: 'store',
    logContext: () => 'CLI',
    logCleanup: false,
});

/**
 * The webview platform; `parts` carries the native members the shell passes
 * in (see the header). Everything else is the family's.
 */
const createWebviewPlatform = (parts: WebviewNativeParts = {}): Platform => ({
    // The CapacitorHttp adapter of api-client.ts, resolved on read so building
    // the platform loads no module graph.
    http: {
        get adapter() {
            return apiClient().getCapacitorHttpAdapter();
        },
    },
    storage: createWebviewStorage(parts.cas ?? null),
    paths: createWebviewPaths(),
    assets: createWebviewAssets(),
    wipe: parts.nativeWipe ? { ...createWebviewWipe(), nativeWipe: parts.nativeWipe } : createWebviewWipe(),
    native: parts.native ?? { autovote: null, foregroundService: null, apkInstaller: null },
    windows: null,
    capabilities: createWebviewCapabilities(),
});

export { createWebviewPlatform };
