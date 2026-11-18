/**
 * A paired phone's own preferences against the host's scenario-driven presentation: the phone's theme, language, compactCards
 * and compactCardActions live in its own browser store (`gs-remote-view-prefs`) and are never overwritten by what the computer
 * publishes — not by a settings event, not by either effective projection event, and not by a stale or replayed one. Two
 * browsers paired to one computer each keep their own four. The host's own presentation is kept apart for a panel that inspects
 * it. The events never cause a phone-to-host write.
 */

import { createViewPrefs, VIEW_PREFS_STORAGE } from '../../src/ts/shells/remote/bridge/viewPrefs';
import { createPeerBridgeContext } from '../../src/ts/shells/remote/bridge/context';
import { TransportStub } from '../helpers/remoteTransport';
import { parseJson } from '../helpers/parseJson';
import { THEMES } from '../../src/ts/core/settings/uiDefaults';

import type { ViewPrefs } from '../../src/ts/shells/remote/bridge/viewPrefs';

const [DARK, LIGHT] = THEMES;

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

type Browser = {
    storage: Storage;
    prefs: ViewPrefs;
    sent: Array<{ channel: string; args: unknown[] }>;
    heard: unknown[];
};

/** One browser: its own localStorage, its own bridge context and view-prefs store. */
const browserOn = (storage: Storage): Browser => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
    const ctx = createPeerBridgeContext(new TransportStub('phone'));
    const sent: Browser['sent'] = [];
    const prefs = createViewPrefs({
        ctx,
        sendInvoke: (channel, args) => {
            sent.push({ channel, args });
            return Promise.resolve(undefined);
        },
    });
    return { storage, prefs, sent, heard: [] };
};

/** Runs something as this browser: its storage is the one the page writes to. */
const as = <T>(browser: Browser, run: () => T): T => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: browser.storage });
    return run();
};

const stored = (browser: Browser): unknown => parseJson(browser.storage.getItem(VIEW_PREFS_STORAGE) ?? '{}');

afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
});

const presentation = (revision: number, theme: string | null, language: string | null, available = true) => ({
    revision,
    available,
    theme,
    language,
    reason: available ? null : 'theme-unavailable',
});

const settingsEvent = (revision: number, values: Record<string, unknown>) => ({
    revision,
    subject: 'installation',
    generation: 1,
    values,
});

const known = (value: unknown) => ({ available: true, source: 'scenario', value });

describe('two browsers paired to one computer', () => {
    test('each keeps its own four preferences, whatever the other writes and whatever the computer publishes', async () => {
        const first = browserOn(memoryStorage());
        const second = browserOn(memoryStorage());

        as(first, () => {
            void first.prefs.route('set-setting', ['theme', DARK]);
            void first.prefs.route('set-setting', ['language', 'lv']);
            void first.prefs.route('set-global-default', ['compactCards', true]);
            void first.prefs.route('set-global-default', ['compactCardActions', false]);
        });
        as(second, () => {
            void second.prefs.route('set-setting', ['theme', LIGHT]);
            void second.prefs.route('set-setting', ['language', 'en']);
            void second.prefs.route('set-global-default', ['compactCards', false]);
            void second.prefs.route('set-global-default', ['compactCardActions', true]);
        });

        // The computer's scenario publishes something else entirely, to both.
        for (const browser of [first, second]) {
            as(browser, () => {
                browser.prefs.ingestEffective('effective-presentation-changed', presentation(5, 'other-theme', 'de'));
                browser.prefs.ingestEffective(
                    'effective-settings-changed',
                    settingsEvent(5, {
                        theme: known({ kind: 'string', value: 'other-theme' }),
                        language: known({ kind: 'string', value: 'de' }),
                        compactCards: known({ kind: 'boolean', value: true }),
                        compactCardActions: known({ kind: 'boolean', value: true }),
                    }),
                );
            });
        }

        expect(stored(first)).toMatchObject({
            theme: DARK,
            language: 'lv',
            compactCards: true,
            compactCardActions: false,
        });
        expect(stored(second)).toMatchObject({
            theme: LIGHT,
            language: 'en',
            compactCards: false,
            compactCardActions: true,
        });
        await expect(as(first, () => first.prefs.route('get-setting', ['theme']))).resolves.toBe(DARK);
        await expect(as(second, () => second.prefs.route('get-setting', ['theme']))).resolves.toBe(LIGHT);
        // Neither browser sent anything to the computer for any of it.
        expect(first.sent).toEqual([]);
        expect(second.sent).toEqual([]);
    });
});

describe('the host effective-presentation event', () => {
    const held = () => {
        const browser = browserOn(memoryStorage());
        as(browser, () => {
            void browser.prefs.route('set-setting', ['theme', DARK]);
            void browser.prefs.route('set-setting', ['language', 'lv']);
        });
        return browser;
    };

    test("reaches the listeners with the phone's own theme and language in place, and changes nothing the phone stored", () => {
        const browser = held();
        const before = browser.storage.getItem(VIEW_PREFS_STORAGE);
        const heard = as(browser, () =>
            browser.prefs.ingestEffective('effective-presentation-changed', presentation(7, LIGHT, 'en')),
        );
        expect(heard).toEqual({ revision: 7, available: true, theme: DARK, language: 'lv', reason: null });
        expect(browser.storage.getItem(VIEW_PREFS_STORAGE)).toBe(before);
        expect(browser.sent).toEqual([]);
    });

    test('updates the host-inspection model with what the computer paints, never what the phone chose', () => {
        const browser = held();
        expect(browser.prefs.hostPresentation()).toBeNull();
        as(browser, () =>
            browser.prefs.ingestEffective('effective-presentation-changed', presentation(7, LIGHT, 'en')),
        );
        expect(browser.prefs.hostPresentation()).toEqual({
            revision: 7,
            available: true,
            theme: LIGHT,
            language: 'en',
        });
        as(browser, () =>
            browser.prefs.ingestEffective('effective-presentation-changed', presentation(8, null, null, false)),
        );
        expect(browser.prefs.hostPresentation()).toEqual({
            revision: 8,
            available: false,
            theme: null,
            language: null,
        });
    });

    test("a key the phone holds no value for takes the computer's", () => {
        const browser = browserOn(memoryStorage());
        const heard = browser.prefs.ingestEffective('effective-presentation-changed', presentation(1, LIGHT, 'en'));
        expect(heard).toMatchObject({ theme: LIGHT, language: 'en' });
    });

    test('a non-string value from the computer is carried as none', () => {
        const browser = browserOn(memoryStorage());
        const heard = browser.prefs.ingestEffective('effective-presentation-changed', {
            revision: 1,
            available: 'yes',
            theme: 4,
            language: undefined,
        });
        expect(heard).toMatchObject({ theme: null, language: null });
        expect(browser.prefs.hostPresentation()).toEqual({
            revision: 1,
            available: false,
            theme: null,
            language: null,
        });
    });

    test.each([
        ['a revision no newer than the last', 7],
        ['an older revision', 6],
    ])('%s is ignored: stale', (_label, revision) => {
        const browser = held();
        as(browser, () =>
            browser.prefs.ingestEffective('effective-presentation-changed', presentation(7, LIGHT, 'en')),
        );
        expect(
            as(browser, () =>
                browser.prefs.ingestEffective('effective-presentation-changed', presentation(revision, 'x', 'y')),
            ),
        ).toBeNull();
        expect(browser.prefs.hostPresentation()).toMatchObject({ revision: 7, theme: LIGHT });
    });

    test.each([
        ['not an object', 'text'],
        ['without a revision', { theme: 'x' }],
        ['with a revision that is not a count', { revision: -1 }],
        ['with a fractional revision', { revision: 1.5 }],
    ])('%s is ignored: not a projection', (_label, payload) => {
        const browser = held();
        expect(browser.prefs.ingestEffective('effective-presentation-changed', payload)).toBeNull();
        expect(browser.prefs.ingestEffective('effective-settings-changed', payload)).toBeNull();
        expect(browser.prefs.hostPresentation()).toBeNull();
    });
});

describe('the host effective-settings event', () => {
    test("carries the phone's own four preferences over the computer's, leaves every other value and the rest of the event alone", () => {
        const browser = browserOn(memoryStorage());
        as(browser, () => {
            void browser.prefs.route('set-setting', ['theme', DARK]);
            void browser.prefs.route('set-setting', ['language', 'lv']);
            void browser.prefs.route('set-global-default', ['compactCards', true]);
            void browser.prefs.route('set-global-default', ['compactCardActions', false]);
        });
        const exposure = known({ kind: 'number', value: 50, quantity: 'count' });
        const heard = as(browser, () =>
            browser.prefs.ingestEffective(
                'effective-settings-changed',
                settingsEvent(3, {
                    theme: known({ kind: 'string', value: 'other' }),
                    language: known({ kind: 'string', value: 'de' }),
                    compactCards: known({ kind: 'boolean', value: false }),
                    compactCardActions: known({ kind: 'boolean', value: true }),
                    exposure,
                }),
            ),
        ) as { revision: number; subject: string; generation: number; values: Record<string, unknown> };
        expect(heard).toMatchObject({ revision: 3, subject: 'installation', generation: 1 });
        expect(heard.values).toEqual({
            theme: { available: true, source: 'saved', value: { kind: 'string', value: DARK } },
            language: { available: true, source: 'saved', value: { kind: 'string', value: 'lv' } },
            compactCards: { available: true, source: 'saved', value: { kind: 'boolean', value: true } },
            compactCardActions: { available: true, source: 'saved', value: { kind: 'boolean', value: false } },
            exposure,
        });
    });

    test('a key the phone holds no value for, or the event does not carry, passes as it came', () => {
        const browser = browserOn(memoryStorage());
        as(browser, () => void browser.prefs.route('set-setting', ['theme', DARK]));
        const language = known({ kind: 'string', value: 'de' });
        const heard = as(browser, () =>
            browser.prefs.ingestEffective('effective-settings-changed', settingsEvent(1, { language })),
        ) as { values: Record<string, unknown> };
        expect(heard.values).toEqual({ language });
    });

    test('an event whose values are not a record is not a projection', () => {
        const browser = browserOn(memoryStorage());
        expect(browser.prefs.ingestEffective('effective-settings-changed', { revision: 1, values: [] })).toBeNull();
        // And it did not use up its revision: the next real one with that revision is heard.
        expect(browser.prefs.ingestEffective('effective-settings-changed', settingsEvent(1, {}))).not.toBeNull();
    });

    test('a stale or repeated revision is ignored, and the two projections count their revisions apart', () => {
        const browser = browserOn(memoryStorage());
        expect(browser.prefs.ingestEffective('effective-settings-changed', settingsEvent(4, {}))).not.toBeNull();
        expect(browser.prefs.ingestEffective('effective-settings-changed', settingsEvent(4, {}))).toBeNull();
        expect(browser.prefs.ingestEffective('effective-settings-changed', settingsEvent(3, {}))).toBeNull();
        expect(
            browser.prefs.ingestEffective('effective-presentation-changed', presentation(1, DARK, 'en')),
        ).not.toBeNull();
    });
});
