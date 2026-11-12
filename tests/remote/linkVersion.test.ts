/** The retained link-version storage behavior: Disconnect clears history and the router bounds one bounce. */

import {
    clearLinkVersion,
    clearSkipMark,
    LINK_VERSION_STORAGE,
    markSkippedTo,
    SKIPPED_TO_STORAGE,
    skippedTo,
} from '../../src/ts/core/remote/linkVersion';

const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);

describe('the remote link-version marker', () => {
    let local: Map<string, string>;
    let session: Map<string, string>;
    beforeEach(() => {
        local = new Map();
        session = new Map();
        Object.defineProperty(globalThis, 'localStorage', {
            configurable: true,
            value: {
                getItem: (key: string) => local.get(key) ?? null,
                setItem: (key: string, value: string) => local.set(key, value),
                removeItem: (key: string) => local.delete(key),
            },
        });
        Object.defineProperty(globalThis, 'sessionStorage', {
            configurable: true,
            value: {
                getItem: (key: string) => session.get(key) ?? null,
                setItem: (key: string, value: string) => session.set(key, value),
                removeItem: (key: string) => session.delete(key),
            },
        });
    });

    afterEach(() => {
        delete (globalThis as { localStorage?: unknown }).localStorage;
        delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    });

    test('Disconnect clears the historical stored-version preference', () => {
        local.set(LINK_VERSION_STORAGE, 'historical');
        clearLinkVersion();
        expect(local.get(LINK_VERSION_STORAGE)).toBeUndefined();
    });

    test('keeps and clears one strict per-tab bounce target without using localStorage', () => {
        const target = { key: KEY_A, linkVersion: 2 };
        markSkippedTo(target);
        expect(session.get(SKIPPED_TO_STORAGE)).toBe(`2:${KEY_A}`);
        expect(local.has(SKIPPED_TO_STORAGE)).toBe(false);
        expect(skippedTo(target)).toBe(true);
        clearSkipMark();
        expect(session.get(SKIPPED_TO_STORAGE)).toBeUndefined();
        expect(skippedTo(target)).toBe(false);
    });

    test('does not block another key or another checked version', () => {
        markSkippedTo({ key: KEY_A, linkVersion: 1 });
        expect(skippedTo({ key: KEY_B, linkVersion: 1 })).toBe(false);
        expect(skippedTo({ key: KEY_A, linkVersion: 2 })).toBe(false);
    });

    test.each(['1', '0', '01', '1000', '1e0', `2:${KEY_A}:extra`, '2:not-a-key'])(
        'does not accept legacy or malformed marker %s',
        (value) => {
            session.set(SKIPPED_TO_STORAGE, value);
            expect(skippedTo({ key: KEY_A, linkVersion: 2 })).toBe(false);
        },
    );

    test('storage refusal is best effort and does not leak the target into localStorage', () => {
        Object.defineProperty(globalThis, 'sessionStorage', {
            configurable: true,
            value: {
                getItem: () => {
                    throw new Error('blocked');
                },
                setItem: () => {
                    throw new Error('blocked');
                },
                removeItem: () => {
                    throw new Error('blocked');
                },
            },
        });
        const target = { key: KEY_A, linkVersion: 2 };
        expect(() => markSkippedTo(target)).not.toThrow();
        expect(skippedTo(target)).toBe(false);
        expect(() => clearSkipMark()).not.toThrow();
        expect(local.has(SKIPPED_TO_STORAGE)).toBe(false);
    });
});
