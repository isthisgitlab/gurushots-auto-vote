/**
 * The link version the phone keeps for the loader: what it holds (a fingerprint of the pairing room and a
 * link version, never the key), when it is trusted, and the tab's loop-guard mark.
 */

import {
    LINK_VERSION_STORAGE,
    SKIPPED_TO_STORAGE,
    clearLinkVersion,
    clearSkipMark,
    markSkippedTo,
    skippedTo,
    storeLinkVersion,
    storedLinkVersion,
} from '../../src/ts/core/remote/linkVersion';

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

describe('the link version kept for the loader', () => {
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
        test('keeps a 16-digit fingerprint of the room and the link version, and not the key', async () => {
            await storeLinkVersion(2);
            const value = local.getItem(LINK_VERSION_STORAGE);
            expect(value).toMatch(/^[0-9a-f]{16}:2$/);
            expect(value).not.toContain(KEY);
            expect(LINK_VERSION_STORAGE).toBe('gs-remote-link-version');
        });

        test('the same key always gets the same fingerprint, and another key another one', async () => {
            await storeLinkVersion(1);
            const first = local.getItem(LINK_VERSION_STORAGE);
            await storeLinkVersion(1);
            expect(local.getItem(LINK_VERSION_STORAGE)).toBe(first);
            setGlobals({ localStorage: local, sessionStorage: session, hash: `#k=${OTHER_KEY}` });
            await storeLinkVersion(1);
            expect(local.getItem(LINK_VERSION_STORAGE)).not.toBe(first);
        });

        test.each([0, -1, 1.5, 1000, NaN])('%p is not a link version and is not kept', async (value) => {
            await storeLinkVersion(value);
            expect(local.getItem(LINK_VERSION_STORAGE)).toBeNull();
        });

        test('a page without a key keeps nothing', async () => {
            setGlobals({ localStorage: local, sessionStorage: session, hash: '' });
            await storeLinkVersion(1);
            expect(local.getItem(LINK_VERSION_STORAGE)).toBeNull();
        });

        test('a browser that refuses site data keeps nothing and does not throw', async () => {
            setGlobals({ localStorage: refusingStorage(), sessionStorage: refusingStorage() });
            await expect(storeLinkVersion(1)).resolves.toBeUndefined();
            setGlobals({});
            await expect(storeLinkVersion(1)).resolves.toBeUndefined();
        });
    });

    describe('reading', () => {
        test('answers the link version kept for this key', async () => {
            await storeLinkVersion(999);
            await expect(storedLinkVersion(KEY)).resolves.toBe(999);
            expect(local.getItem(LINK_VERSION_STORAGE)).not.toBeNull();
        });

        test('nothing kept answers null', async () => {
            await expect(storedLinkVersion(KEY)).resolves.toBeNull();
        });

        test('a value kept for another pairing is not trusted: null, and cleared', async () => {
            await storeLinkVersion(1);
            await expect(storedLinkVersion(OTHER_KEY)).resolves.toBeNull();
            expect(local.getItem(LINK_VERSION_STORAGE)).toBeNull();
        });

        test.each([
            ['no separator', 'garbage'],
            ['an empty number', 'aaaaaaaaaaaaaaaa:'],
            ['an app version in place of the number', 'aaaaaaaaaaaaaaaa:1.15.0'],
            ['a word', 'aaaaaaaaaaaaaaaa:latest'],
        ])('a stored value with %s is cleared and answers null', async (_name, value) => {
            local.setItem(LINK_VERSION_STORAGE, value);
            await expect(storedLinkVersion(KEY)).resolves.toBeNull();
            expect(local.getItem(LINK_VERSION_STORAGE)).toBeNull();
        });

        test.each([
            ['zero', '0'],
            ['a leading zero', '01'],
            ['an exponent', '1e0'],
            ['a sign', '+1'],
            ['a negative number', '-1'],
            ['a fraction', '1.5'],
            ['four digits', '1000'],
            ['trailing text', '1 and more'],
        ])(
            "a value with this pairing key's real fingerprint and %s in place of the number is cleared and answers null",
            async (_name, number) => {
                await storeLinkVersion(1);
                const [fingerprint] = (local.getItem(LINK_VERSION_STORAGE) ?? '').split(':');
                expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
                local.setItem(LINK_VERSION_STORAGE, `${fingerprint}:${number}`);
                await expect(storedLinkVersion(KEY)).resolves.toBeNull();
                expect(local.getItem(LINK_VERSION_STORAGE)).toBeNull();
            },
        );

        test('a browser that refuses site data answers null', async () => {
            setGlobals({ localStorage: refusingStorage(), sessionStorage: refusingStorage() });
            await expect(storedLinkVersion(KEY)).resolves.toBeNull();
        });
    });

    describe('clearing', () => {
        test('forgets the kept link version, whether or not any is kept', async () => {
            await storeLinkVersion(1);
            clearLinkVersion();
            expect(local.getItem(LINK_VERSION_STORAGE)).toBeNull();
            clearLinkVersion();
            setGlobals({ localStorage: refusingStorage() });
            expect(() => clearLinkVersion()).not.toThrow();
        });
    });

    describe("the tab's loop guard", () => {
        test('remembers the link version the tab went straight to, in the stored form, and forgets it when asked', () => {
            expect(skippedTo()).toBeNull();
            markSkippedTo(2);
            expect(skippedTo()).toBe(2);
            expect(session.getItem(SKIPPED_TO_STORAGE)).toBe('2');
            clearSkipMark();
            expect(skippedTo()).toBeNull();
        });

        test('a mark that is not of the stored form reads as no mark', () => {
            session.setItem(SKIPPED_TO_STORAGE, '1.15.0');
            expect(skippedTo()).toBeNull();
            session.setItem(SKIPPED_TO_STORAGE, '01');
            expect(skippedTo()).toBeNull();
        });

        test("is in the tab's session storage and never in local storage", () => {
            markSkippedTo(2);
            expect(local.length).toBe(0);
        });

        test('a browser that refuses site data has no mark, and nothing throws', () => {
            setGlobals({ localStorage: refusingStorage(), sessionStorage: refusingStorage() });
            expect(() => markSkippedTo(2)).not.toThrow();
            expect(skippedTo()).toBeNull();
            expect(() => clearSkipMark()).not.toThrow();
        });
    });
});
