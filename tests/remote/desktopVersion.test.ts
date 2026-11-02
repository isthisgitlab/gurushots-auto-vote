/**
 * The desktop version the phone keeps for the loader: what it holds (a fingerprint of the pairing room and a
 * release version, never the key), when it is trusted, and the tab's loop-guard mark.
 */

import {
    DESKTOP_VERSION_STORAGE,
    SKIPPED_TO_STORAGE,
    clearDesktopVersion,
    clearSkipMark,
    markSkippedTo,
    skippedTo,
    storeDesktopVersion,
    storedDesktopVersion,
} from '../../src/ts/core/remote/desktopVersion';

const KEY = 'k'.repeat(43);
const OTHER_KEY = 'o'.repeat(43);

const memoryStorage = (): Storage => {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (name) => items.get(name) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (name) => void items.delete(name),
        setItem: (name, value) => void items.set(name, value),
    };
};

const refusingStorage = (): Storage => {
    const refuse = (): never => {
        throw new Error('site data refused');
    };
    return { length: 0, clear: refuse, getItem: refuse, key: refuse, removeItem: refuse, setItem: refuse };
};

const setGlobals = (globals: { localStorage?: Storage; sessionStorage?: Storage; hash?: string }): void => {
    for (const [name, value] of Object.entries({
        localStorage: globals.localStorage,
        sessionStorage: globals.sessionStorage,
        location: { hash: globals.hash ?? `#k=${KEY}` },
    })) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
};

describe('the desktop version kept for the loader', () => {
    let local: Storage;
    let session: Storage;

    beforeEach(() => {
        local = memoryStorage();
        session = memoryStorage();
        setGlobals({ localStorage: local, sessionStorage: session });
    });
    afterEach(() => {
        for (const name of ['localStorage', 'sessionStorage', 'location']) {
            delete (globalThis as Record<string, unknown>)[name];
        }
    });

    describe('storing', () => {
        test('keeps a 16-digit fingerprint of the room and the version, and not the key', async () => {
            await storeDesktopVersion('1.15.0-beta.3');
            const value = local.getItem(DESKTOP_VERSION_STORAGE);
            expect(value).toMatch(/^[0-9a-f]{16}:1\.15\.0-beta\.3$/);
            expect(value).not.toContain(KEY);
            expect(DESKTOP_VERSION_STORAGE).toBe('gs-remote-desktop-version');
        });

        test('the same key always gets the same fingerprint, and another key another one', async () => {
            await storeDesktopVersion('1.2.3');
            const first = local.getItem(DESKTOP_VERSION_STORAGE);
            await storeDesktopVersion('1.2.3');
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).toBe(first);
            setGlobals({ localStorage: local, sessionStorage: session, hash: `#k=${OTHER_KEY}` });
            await storeDesktopVersion('1.2.3');
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).not.toBe(first);
        });

        test('a version that is not a release version is not kept', async () => {
            await storeDesktopVersion('../../etc/passwd');
            await storeDesktopVersion('latest');
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).toBeNull();
        });

        test('a page without a key keeps nothing', async () => {
            setGlobals({ localStorage: local, sessionStorage: session, hash: '' });
            await storeDesktopVersion('1.2.3');
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).toBeNull();
        });

        test('a browser that refuses site data keeps nothing and does not throw', async () => {
            setGlobals({ localStorage: refusingStorage(), sessionStorage: refusingStorage() });
            await expect(storeDesktopVersion('1.2.3')).resolves.toBeUndefined();
            setGlobals({});
            await expect(storeDesktopVersion('1.2.3')).resolves.toBeUndefined();
        });
    });

    describe('reading', () => {
        test('answers the version kept for this key', async () => {
            await storeDesktopVersion('1.15.0-beta.3');
            await expect(storedDesktopVersion(KEY)).resolves.toBe('1.15.0-beta.3');
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).not.toBeNull();
        });

        test('nothing kept answers null', async () => {
            await expect(storedDesktopVersion(KEY)).resolves.toBeNull();
        });

        test('a version kept for another pairing is not trusted: null, and cleared', async () => {
            await storeDesktopVersion('1.2.3');
            await expect(storedDesktopVersion(OTHER_KEY)).resolves.toBeNull();
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).toBeNull();
        });

        test.each([
            ['no separator', 'garbage'],
            ['an empty version', 'aaaaaaaaaaaaaaaa:'],
            ['a version that is not a release version', 'aaaaaaaaaaaaaaaa:latest'],
            ['a path in place of the version', 'aaaaaaaaaaaaaaaa:../x'],
        ])('a stored value with %s is cleared and answers null', async (_name, value) => {
            local.setItem(DESKTOP_VERSION_STORAGE, value);
            await expect(storedDesktopVersion(KEY)).resolves.toBeNull();
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).toBeNull();
        });

        test('a browser that refuses site data answers null', async () => {
            setGlobals({ localStorage: refusingStorage(), sessionStorage: refusingStorage() });
            await expect(storedDesktopVersion(KEY)).resolves.toBeNull();
        });
    });

    describe('clearing', () => {
        test('forgets the kept version, whether or not one is kept, and does not throw where storage is refused', async () => {
            await storeDesktopVersion('1.2.3');
            clearDesktopVersion();
            expect(local.getItem(DESKTOP_VERSION_STORAGE)).toBeNull();
            clearDesktopVersion();
            setGlobals({ localStorage: refusingStorage() });
            expect(() => clearDesktopVersion()).not.toThrow();
        });
    });

    describe("the tab's loop guard", () => {
        test('remembers the version the tab went straight to, and forgets it when asked', () => {
            expect(skippedTo()).toBeNull();
            markSkippedTo('2.0.0');
            expect(skippedTo()).toBe('2.0.0');
            expect(session.getItem(SKIPPED_TO_STORAGE)).toBe('2.0.0');
            clearSkipMark();
            expect(skippedTo()).toBeNull();
        });

        test("is in the tab's session storage and never in local storage", () => {
            markSkippedTo('2.0.0');
            expect(local.length).toBe(0);
        });

        test('a browser that refuses site data has no mark, and nothing throws', () => {
            setGlobals({ localStorage: refusingStorage(), sessionStorage: refusingStorage() });
            expect(() => markSkippedTo('2.0.0')).not.toThrow();
            expect(skippedTo()).toBeNull();
            expect(() => clearSkipMark()).not.toThrow();
        });
    });
});
