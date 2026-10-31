/**
 * The headless family's storage member: the AndroidHeadlessStore bridge
 * transport of the background service. `jsonStore` and `settingsFile` build
 * one transport object per store over the native bridge: the keyed reads and
 * writes (`readKey` / `writeKey`) with the per-key memory cache and the
 * failed-reads registry, the compare-and-write of a shared key
 * (`compareAndWriteKey`), and the settings file through the bridge's own
 * `read` / `write` pair (the dedicated bridge) or the keyed calls. Where the
 * key is not shared, a change is made and saved in one step (core's writeNow
 * over this transport's own operations); hydrate and flush are no-ops — the
 * bridge read is the store.
 *
 * The bridge is the `AndroidHeadlessStore` global the native side injects,
 * read at call time. The wrapped modules are reached at call time, never at
 * load: the node project's setup file loads the test helpers that import
 * this family, so a module graph loaded at import time would land in the
 * setup's registry before a test file registers its own mocks
 * (platforms/node/index.ts states the reason in full).
 */

import type {
    JsonStoreTransport,
    PlatformStorage,
    SettingsFileTransport,
    SettingsFileWiring,
    SettingsStoreRef,
} from '../../platform/port';
import type { WriteIfAbsentResult, WriteResult } from '../../settings/storageTypes';
import type { AndroidHeadlessStore, HeadlessSettingsBridge } from '../../types/settings';
import type { ThroughResult } from '../../types/stores';

type LoggerModule = typeof import('../../logger');
type SaveDroppedModule = typeof import('../../settings/saveDropped');
type JsonStoreModule = typeof import('../../settings/jsonStore');

// See the header: the wrapped modules, reached at call time.
const logger = (): LoggerModule => require('../../logger') as LoggerModule;
const saveDropped = (): SaveDroppedModule => require('../../settings/saveDropped') as SaveDroppedModule;
const jsonStore = (): JsonStoreModule => require('../../settings/jsonStore') as JsonStoreModule;

/**
 * The Android headless-service bridge, read at call time (absent everywhere
 * else).
 */
const headlessStore = (): AndroidHeadlessStore | undefined =>
    (globalThis as typeof globalThis & { AndroidHeadlessStore?: AndroidHeadlessStore }).AndroidHeadlessStore;

// The keys whose latest read through the bridge failed (it threw, or a strict store has no bridge to read through).
const failedReads = new Set<string>();

/**
 * Reads one key through the native bridge. A key that is not there answers null, which is the caller's cached value; a
 * read that threw is a failed one (see the `loaded` member), and so is a strict store's read where there is no bridge.
 */
const readHeadlessKey = (prefKey: string, fallback: string | null, strict: boolean): string | null => {
    try {
        const bridge = headlessStore();
        if (strict && !bridge?.readKey) throw new Error('no bridge to read through');
        // aislop-ignore-next-line ai-slop/hidden-fallback -- an absent key is the caller's cached value; the read contract
        const value = bridge?.readKey?.(prefKey) ?? fallback;
        failedReads.delete(prefKey);
        return value;
    } catch (err) {
        // Said when it first fails, not on every read after it: the service reads the key many times a pass.
        if (!failedReads.has(prefKey)) logger().withCategory('settings').error(`Headless ${prefKey} read failed:`, err);
        failedReads.add(prefKey);
        // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the settings logger; failedReads says it failed
        return fallback;
    }
};

/**
 * Writes one key through the native bridge. The bridge answers `false` when it did not persist the value (a
 * refused key, a value that is no JSON, a failed commit). A write that was not passes quietly, except for a `strict`
 * store, which throws, and which takes nothing but a `true` for a write that was (no bridge, or none that answers,
 * is not one).
 */
const writeHeadlessKey = (prefKey: string, data: string, strict: boolean): void => {
    const answer = ((): boolean | void => {
        try {
            return headlessStore()?.writeKey?.(prefKey, data);
        } catch (err) {
            logger().withCategory('settings').error(`Headless ${prefKey} write failed:`, err);
            return false;
        }
    })();
    if (strict && answer !== true) throw new Error(`Headless ${prefKey} was not persisted`);
};

// How often a change made against a shared store is made again on what another writer saved meanwhile, before it
// is given up as not saved.
const MAX_ATTEMPTS = 5;

/** The native side of one settings key: read it (the text the next write is a change of), and save a change of it. */
type KeyedRefusal = ReturnType<NonNullable<AndroidHeadlessStore['lastWriteRefusal']>>;

// What each key reached through the keyed calls was last read as: the text its next write is a change of.
const keyedReads = new Map<string, string | null>();

/**
 * One settings key reached through the bridge's keyed calls (`readKey` / `compareAndWriteKey`), with the semantics of
 * the dedicated `read` / `write` pair: a write saves only while the key still holds what the latest read of it
 * answered. Throws when the bridge has no keyed calls.
 */
const keyedSettingsBridge = (prefKey: string): HeadlessSettingsBridge => {
    const bridge = headlessStore();
    if (!bridge?.readKey || !bridge.compareAndWriteKey) throw new Error('no bridge to read the settings through');
    const { readKey, compareAndWriteKey } = bridge;
    let refusal: KeyedRefusal = '';
    return {
        read: () => {
            const text = readKey.call(bridge, prefKey);
            keyedReads.set(prefKey, text);
            return text;
        },
        write: (data) => {
            const expected = keyedReads.get(prefKey) ?? '';
            const saved = compareAndWriteKey.call(bridge, prefKey, expected, data);
            if (saved) keyedReads.set(prefKey, data);
            refusal = saved ? '' : readKey.call(bridge, prefKey) === expected ? 'refused' : 'conflict';
            return saved;
        },
        lastWriteRefusal: () => refusal,
    };
};

/**
 * Saves the settings text `ours`, made from `base` (what this context last read), through the bridge's `write`, which
 * the native side takes only while the settings still hold what the latest `read` answered. A blob the other writer
 * changed since is read again and `ours` made on it (`rebase`), up to MAX_ATTEMPTS.
 *
 * @returns the text saved (`ours` when no bridge answers: there is nothing to refuse it); null when the bridge refused
 *   it, which trying again does not help
 * @throws when the bridge threw, the stored settings are unreadable, or they kept changing
 */
const headlessSettingsWrite = (
    bridge: HeadlessSettingsBridge | undefined,
    rebase: (base: string | null, ours: string, theirs: string | null) => string,
    base: string | null,
    ours: string,
): string | null => {
    if (!bridge) return ours;
    let theirs = base;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const text = rebase(base, ours, theirs);
        if (bridge.write(text) !== false) return text;
        const now = bridge.read();
        // Nothing changed under it: the save itself was refused.
        if (now === theirs) return null;
        theirs = now;
    }
    throw new (saveDropped().SaveConflictError)('the settings kept changing');
};

/**
 * A change of a key that the background service writes too, made in the service's own context: read the key through
 * the bridge, make the new value from it, and save it only if the key still holds what was read (the native side
 * takes one lock for both contexts). A key that changed meanwhile is read again and the change made again on it.
 * `update` may be called more than once, and must make the same change each time.
 *
 * @returns `saved`; `aborted` (`update` answered null); `failed` (no bridge, a refused or failed save, or a key that
 *   kept changing)
 */
const headlessUpdate = (prefKey: string, update: (current: string | null) => string | null): ThroughResult => {
    try {
        const bridge = headlessStore();
        if (!bridge?.readKey || !bridge.compareAndWriteKey) throw new Error('no bridge to change through');
        let current = bridge.readKey(prefKey);
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const data = update(current);
            if (data === null) return 'aborted';
            if (bridge.compareAndWriteKey(prefKey, current ?? '', data)) return 'saved';
            const now = bridge.readKey(prefKey);
            // Nothing changed under it, or what is there is the value just offered (a refused save that the bridge's own
            // memory still shows): the save itself was refused, and trying again will not help.
            if (now === current || now === data) throw new Error('the bridge refused the value');
            current = now;
        }
        throw new Error('the key kept changing');
    } catch (error) {
        logger().withCategory('settings').error(`Headless ${prefKey} could not be changed:`, error);
        return 'failed';
    }
};

// The Android background service's write: persist through the native bridge to the shared store, as a change of the
// text this context read — the app window saves the same blob, and what it saved meanwhile is kept (see
// headlessSettingsWrite). The commit is synchronous so a later read() in the same cycle sees the new value.
const writeThroughHeadlessStore = (
    state: { headlessBase: string | null },
    bridge: () => HeadlessSettingsBridge | undefined,
    rebase: (base: string | null, ours: string, theirs: string | null) => string,
    data: string,
): WriteResult => {
    try {
        const saved = headlessSettingsWrite(bridge(), rebase, state.headlessBase, data);
        if (saved === null) {
            // The native side says why: the blob is past its size limit, it changed under the write, or the commit failed.
            const why = bridge()?.lastWriteRefusal?.();
            logger()
                .withCategory('settings')
                .error(`Headless store refused the settings write${why ? ` (${why})` : ''}`, null);
            return { ok: false };
        }
        state.headlessBase = saved;
    } catch (err) {
        logger().withCategory('settings').error('Headless store write failed:', err);
        return { ok: false };
    }
    return { ok: true };
};

// The Android background service's writeIfAbsent: the native compare-and-write decides which of the two contexts (the
// app window and this service) is first; the other finds what the first saved (`exists`, with the text) and has
// nothing to write.
const writeIfAbsentThroughHeadlessStore = (
    state: { headlessBase: string | null },
    bridge: () => HeadlessSettingsBridge | undefined,
    data: string,
): WriteIfAbsentResult => {
    try {
        const answer = bridge();
        if (!answer) {
            state.headlessBase = data;
            return { outcome: 'saved' };
        }
        if (answer.write(data) !== false) {
            state.headlessBase = data;
            return { outcome: 'saved' };
        }
        const current = answer.read();
        if (current !== null) {
            state.headlessBase = current;
            return { outcome: 'exists', current };
        }
        logger()
            .withCategory('settings')
            .error(`Headless store refused the settings write (${answer.lastWriteRefusal?.() || 'refused'})`, null);
    } catch (err) {
        logger().withCategory('settings').error('Headless store write failed:', err);
    }
    return { outcome: 'failed' };
};

// The bridge pair this file's reads and writes go through on Android: the background service reaches its key through
// the bridge's own read/write pair; the app window's files go through the keyed calls. Both sides are resolved per
// call, as the factory's inline bridge did.
const makeFileBridge = (dedicatedBridge: boolean, prefKey: string): (() => HeadlessSettingsBridge | undefined) => {
    if (dedicatedBridge) return () => headlessStore();
    return () => keyedSettingsBridge(prefKey);
};

// The generic JSON store's bridge transport. `flags.shared` marks a key the
// app window writes too: its change is saved by the native compare-and-write
// (headlessUpdate), so no change is erased; the rest go through writeNow.
const jsonStoreTransport = (ref: SettingsStoreRef, flags: { strict: boolean; shared: boolean }): JsonStoreTransport => {
    // What the latest read of the key answered (null: nothing, or the read failed): the text the next write is a
    // change of, and what a failed read answers (it says nothing of what is stored).
    let cache: string | null = null;
    const readRaw = (): string | null => readHeadlessKey(ref.prefKey, cache, flags.strict);
    const writeRaw = (data: string): void => {
        // Only a write that is confirmed is read back: a failed first write leaves nothing to read.
        writeHeadlessKey(ref.prefKey, data, flags.strict);
        cache = data;
    };
    const updateNow = (update: (current: string | null) => string | null): ThroughResult =>
        flags.shared
            ? headlessUpdate(ref.prefKey, update)
            : jsonStore().writeNow(ref.prefKey, { readRaw, writeRaw }, update);
    return {
        readRaw,
        writeRaw,
        hydrate: async () => undefined,
        reread: async () => true,
        updateNow,
        updateThrough: async (update) => updateNow(update),
        peekStored: async () => readRaw(),
        flush: async () => undefined,
        discard: () => {
            cache = null;
        },
    };
};

// The settings file's bridge transport (the service half of the one blob the app window saves through Preferences).
const settingsFileTransport = (ref: SettingsStoreRef, wiring: SettingsFileWiring): SettingsFileTransport => {
    // The text the JS last read from the native store: the text its next write is a change of.
    const state = { headlessBase: null as string | null };
    const bridge = makeFileBridge(wiring.dedicatedBridge, ref.prefKey);
    return {
        readRaw: () => {
            // Read from the native bridge backed by the same store the app's
            // @capacitor/preferences uses, so the token and settings stay in sync between app and background.
            state.headlessBase = bridge()?.read() || null;
            return state.headlessBase;
        },
        write: (data) => writeThroughHeadlessStore(state, bridge, wiring.rebase, data),
        writeIfAbsent: (data) => writeIfAbsentThroughHeadlessStore(state, bridge, data),
        location: () => ref.prefKey,
        isLoaded: () => headlessStore() !== undefined,
        isPersisted: () => true,
        hasQuarantined: () => false,
        quarantineRaw: () => ({
            ok: false,
            error: 'the background service cannot set an unusable settings value aside',
        }),
        hydrate: async () => undefined,
        flush: async () => undefined,
        discard: async () => undefined,
    };
};

const createHeadlessStorage = (): PlatformStorage => ({
    jsonStore: jsonStoreTransport,
    settingsFile: settingsFileTransport,
    // A read through the bridge can fail, and the value it answered then (the cache) says nothing of what is stored:
    // a store whose latest read failed is not loaded — its owner must not read it as empty. Ask after the store was
    // read: a read that failed says so only once it was made.
    loaded: (key) => !failedReads.has(key),
    // The native compare-and-write of each key decides; there is no file lock.
    lockPolicy: 'none',
});

export { createHeadlessStorage };
