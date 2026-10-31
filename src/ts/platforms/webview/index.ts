/**
 * The webview platform family: the app WebView (the Capacitor page's Android
 * UI). The CapacitorHttp adapter, the fetch assets, the stub paths, and the
 * wipe that empties the Preferences keys and asks for a reload. The shell's
 * platform module builds this and installs it; the family itself never calls
 * installPlatform.
 *
 * The members that need the shell's own code are passed in through `parts` —
 * every part is required, so a shell that forgets one fails to compile: the
 * native services call services/NativeAutovoteBridge.ts and its siblings
 * (shell modules a family cannot import), the native wipe calls the
 * AutoVoteBackground plugin, the compare-and-write goes to the native bridge,
 * and the windows are the shell's broadcast and reload (bridge/capacitor.ts).
 * The storage transport is a placeholder until Phase 3 step 7 (see store.ts).
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

import type { Platform, PlatformCas, PlatformNative, PlatformWindows, PlatformWipe } from '../../platform/port';

/** The parts the shell module passes in: the native members and the windows, all required. */
type WebviewNativeParts = {
    /**
     * The native compare-and-write of one Preferences key, null where the
     * shell has none. Not read until Phase 3 step 7 — the storage transport
     * is a placeholder until then (store.ts) — and required now so a shell
     * that forgets it fails to compile; step 7 wires it into the storage it
     * restores.
     */
    cas: PlatformCas | null;
    /** The native plugin's wipe (AutoVoteBackground wipeLocalData). */
    nativeWipe: PlatformWipe['nativeWipe'];
    /** The native services (the bridges and controllers the WebView page drives). */
    native: PlatformNative;
    /** The shell's windows: the bridge's settings emit and the post-wipe reload. */
    windows: PlatformWindows;
};

type WebviewHttpModule = typeof import('./http');

const webviewHttp = (): WebviewHttpModule => require('./http') as WebviewHttpModule;

const createWebviewCapabilities = (parts: WebviewNativeParts): Platform['capabilities'] => ({
    // The mission-needs refresh resolver is the headless cycle's; Snap plays
    // from the app; recovery names the store to clear; and the log context
    // and the hourly cleanup are the logger's WebView answers (the default
    // rule answers CLI on a WebView; logger/files arms the interval only for
    // Electron or a CLI start).
    refreshMissionNeeds: false,
    snapAllowed: true,
    // The rule the branch answers today (services/scenarioRunner/step:205):
    // the native background service owns the scenarios while the app WebView
    // has its bridge. Computed from the native part — calling the step's own
    // function would recurse once Phase 3 points it at this capability.
    backgroundServiceOwnsScenarios: () => parts.native.autovote?.isAvailable() === true,
    recoveryWording: 'store',
    logContext: () => 'CLI',
    logCleanup: false,
});

/**
 * The webview platform; `parts` carries the shell's native members and
 * windows, every one required (see the header). Everything else is the
 * family's.
 */
const createWebviewPlatform = (parts: WebviewNativeParts): Platform => ({
    // The CapacitorHttp adapter (./http), resolved on read so building
    // the platform loads no module graph.
    http: {
        get adapter() {
            return webviewHttp().getCapacitorHttpAdapter();
        },
    },
    storage: createWebviewStorage(),
    paths: createWebviewPaths(),
    assets: createWebviewAssets(),
    wipe: { ...createWebviewWipe(), nativeWipe: parts.nativeWipe },
    native: parts.native,
    windows: parts.windows,
    capabilities: createWebviewCapabilities(parts),
});

export { createWebviewPlatform };
