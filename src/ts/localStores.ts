/**
 * The local stores' boot wiring for Capacitor: one list of the stores whose
 * write-behind cache must hydrate from @capacitor/preferences at startup and
 * flush when the WebView is backgrounded or torn down.
 *
 * A local store that is not listed here never hydrates on Android: after a
 * relaunch its cache reads empty and its markers are invisible — for joinState
 * that means a paid retry re-unlocks (a double charge). See
 * docs/architecture.md §7. A new local store is added here, one pair, in the
 * same shape as the rest.
 *
 * Only react/pages/Capacitor.tsx imports this module.
 */

import { initializeAsync as initializeSettingsAsync, flushPendingWrites as flushSettingsWrites } from './settings';
import { initializeMetadataAsync, flushMetadataWrites } from './metadata';
import { initializeJoinStateAsync, flushJoinStateWrites } from './joinStateStore';
import { initializeSwapBackAsync, flushSwapBackWrites } from './swapBackStore';
import { initializeAutoSpendAsync, flushAutoSpendWrites } from './currencyAutoStore';
import { initializeEntryAgesAsync, flushEntryAgeWrites } from './entryAgeStore';
import { initializeScenarioStateAsync, flushScenarioStateWrites } from './scenarioStateStore';
import { initializeDiagnosticsAsync, flushDiagnosticsWrites } from './services/semantic/diagnostics';
import { initializePhotoStatsAsync, flushPhotoStatsWrites } from './services/photoStats';
import { withCategory } from './logger';

/**
 * One `{ initialize, flush }` pair per local store, in boot order. The first pair is the settings facade: it hydrates
 * alone, because the step the caller hands to initializeLocalStores (the page seeds its bridge profiles) reads and
 * writes the settings. Every flush mirrors what the page's teardown did: fired without waiting on it, and the scenario
 * stores' flush says when a write did not persist — logged, and nothing to undo.
 */
const LOCAL_STORES = [
    {
        initialize: initializeSettingsAsync,
        flush: () => void flushSettingsWrites(),
    },
    {
        // Per-challenge vote metadata survives relaunches.
        initialize: initializeMetadataAsync,
        flush: () => void flushMetadataWrites(),
    },
    {
        // Join-state markers (paid-unlock idempotency): a paid retry after relaunch never re-unlocks (double
        // charge) on Android.
        initialize: initializeJoinStateAsync,
        flush: () => void flushJoinStateWrites(),
    },
    {
        // Swap-back records (which slot can restore a boosted/turbo'd photo).
        initialize: initializeSwapBackAsync,
        flush: () => void flushSwapBackWrites(),
    },
    {
        // Automatic exposure-fill counts (the per-challenge fill cap).
        initialize: initializeAutoSpendAsync,
        flush: () => void flushAutoSpendWrites(),
    },
    {
        // When each entry entered its challenge (the boost fresh-entry wait).
        initialize: initializeEntryAgesAsync,
        flush: () => void flushEntryAgeWrites(),
    },
    {
        // Where each challenge is in its user-defined scenario (phase, memory).
        initialize: initializeScenarioStateAsync,
        flush: () =>
            void flushScenarioStateWrites().catch((err) =>
                withCategory('general').error('Scenario state not persisted', err),
            ),
    },
    {
        initialize: initializeDiagnosticsAsync,
        flush: () => void flushDiagnosticsWrites(),
    },
    {
        // Photo stats (the ranking signals fetched per photo): hydrated so a relaunch does not refetch them all.
        initialize: initializePhotoStatsAsync,
        flush: () => void flushPhotoStatsWrites(),
    },
];

// The settings facade's pair, held out of the concurrent hydration of the rest.
const [SETTINGS_STORE, ...REST_STORES] = LOCAL_STORES;

/**
 * Hydrate the local stores for the Capacitor window's boot: the settings facade first and alone, then
 * `afterSettings` — the page seeds its bridge profiles there, and the seeding reads and writes the
 * settings — then the rest together, and waits for them all. None of the initializers rejects: each
 * catches its own read error and still marks itself initialized (createJsonStore), so one failed read
 * never blocks the others or the mount.
 */
export const initializeLocalStores = async (afterSettings: () => void): Promise<void> => {
    await SETTINGS_STORE.initialize();
    afterSettings();
    await Promise.all(REST_STORES.map((store) => store.initialize()));
};

/**
 * Push every local store's write-behind cache to storage, in boot order, without waiting on the answers
 * — a teardown handler can neither throw nor wait. A flush that throws or says a write did not persist
 * is contained here: a thrown one is swallowed (the serialized write chain already guarantees order,
 * this only narrows the durability window), the scenario stores' is logged.
 */
export const flushLocalStores = async (): Promise<void> => {
    try {
        for (const { flush } of LOCAL_STORES) flush();
    } catch {
        // never let a teardown handler throw
    }
};
