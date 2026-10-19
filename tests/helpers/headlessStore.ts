/**
 * The Android service's native store, in memory, for tests that drive the settings through the headless seam
 * (`__GS_HEADLESS__` + `AndroidHeadlessStore`). `value` is the configuration text (`gurushots-config`, through the
 * bridge's dedicated `read` / `write`: a write saves only while the key still holds what the latest read answered);
 * `legacy` is the 1.x `settings.json` text; `keys` holds every other store (the import marker, the title pins).
 * Assigning to `value` or `legacy` changes what the next read sees.
 */

import type { AndroidHeadlessStore } from '../../src/ts/types/settings';

// The Preferences keys of the configuration and of the 1.x settings blob (settings/storage.ts); not imported, so that
// loading this helper does not load the settings.
const CONFIG_KEY = 'gurushots-config';
const LEGACY_SETTINGS_KEY = 'gurushots-settings';

type HeadlessGlobals = typeof globalThis & {
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};

type MemoryStore = AndroidHeadlessStore & {
    read: jest.Mock<string | null, []>;
    write: jest.Mock<boolean, [string]>;
    value: string | null;
    legacy: string | null;
    keys: Map<string, string>;
};

const headless = globalThis as HeadlessGlobals;

/**
 * Points the settings storage at a fresh in-memory store.
 *
 * @param initial - the configuration text and the 1.x settings text it starts with (none: a fresh install)
 */
const installHeadlessStore = (initial: { config?: string | null; legacy?: string | null } = {}): MemoryStore => {
    const keys = new Map<string, string>();
    let lastRead: string | null = null;
    const put = (key: string, value: string | null) => {
        if (value === null) keys.delete(key);
        else keys.set(key, value);
    };
    put(CONFIG_KEY, initial.config ?? null);
    put(LEGACY_SETTINGS_KEY, initial.legacy ?? null);
    const store: MemoryStore = {
        keys,
        get value() {
            return keys.get(CONFIG_KEY) ?? null;
        },
        set value(text: string | null) {
            put(CONFIG_KEY, text);
        },
        get legacy() {
            return keys.get(LEGACY_SETTINGS_KEY) ?? null;
        },
        set legacy(text: string | null) {
            put(LEGACY_SETTINGS_KEY, text);
        },
        read: jest.fn(() => {
            lastRead = keys.get(CONFIG_KEY) ?? null;
            return lastRead;
        }),
        write: jest.fn((data: string) => {
            if ((keys.get(CONFIG_KEY) ?? null) !== lastRead) return false;
            keys.set(CONFIG_KEY, data);
            lastRead = data;
            return true;
        }),
        lastWriteRefusal: () => '',
        readKey: (key) => keys.get(key) ?? null,
        writeKey: (key, data) => {
            keys.set(key, data);
            return true;
        },
        compareAndWriteKey: (key, expected, data) => {
            if ((keys.get(key) ?? '') !== expected) return false;
            keys.set(key, data);
            return true;
        },
    };
    headless.__GS_HEADLESS__ = true;
    headless.AndroidHeadlessStore = store;
    return store;
};

/** Stops pointing the settings storage at the in-memory store. */
const removeHeadlessStore = () => {
    delete headless.__GS_HEADLESS__;
    delete headless.AndroidHeadlessStore;
};

export type { MemoryStore };
export { installHeadlessStore, removeHeadlessStore };
