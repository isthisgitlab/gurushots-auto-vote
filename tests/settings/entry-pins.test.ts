/**
 * The photo a challenge's Boost and Turbo are pinned to, on the settings facade.
 *
 * Covers getEntryPins / setEntryPin (own-property reads, argument hardening, the
 * one-photo-one-feature rule, the map cap and its warning latch) and the stale
 * cleanup of the container. Drives the in-memory headless-store seam, like
 * title-pins.test.ts.
 */

import type { AndroidHeadlessStore } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';
import settings = require('../../src/ts/settings');
import { isAppSettings } from '../helpers/storedShapes';
import { parseJsonAs } from '../helpers/parseJson';

const mockWarning = jest.fn<void, unknown[]>();

jest.mock('../../src/ts/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    isDevMode: jest.fn(() => false),
    isSourceCode: jest.fn(() => true),
    getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: (...args: unknown[]) => mockWarning(...args),
    })),
}));

describe('settings facade — entry pins', () => {
    const headlessGlobals = globalThis as typeof globalThis & {
        __GS_HEADLESS__?: boolean;
        AndroidHeadlessStore?: AndroidHeadlessStore;
    };
    let store: { value: string | null; read: jest.Mock<string | null, []>; write: jest.Mock<void, [string]> };

    beforeEach(() => {
        mockWarning.mockClear();
        headlessGlobals.__GS_HEADLESS__ = true;
        store = {
            value: null,
            read: jest.fn(() => store.value),
            write: jest.fn((d) => {
                store.value = d;
            }),
        };
        headlessGlobals.AndroidHeadlessStore = store;
    });

    afterEach(() => {
        delete headlessGlobals.__GS_HEADLESS__;
        delete headlessGlobals.AndroidHeadlessStore;
    });

    // Edit the persisted blob behind the facade's back (a hand-edited file or a raw save-settings write).
    const tamper = (edit: (entryPins: Record<string, unknown>) => void) => {
        settings.setEntryPin('boost', 'seed', 'seedimg');
        const blob = parseJsonAs(store.value!, isAppSettings);
        edit(blob.challengeSettings.entryPins);
        store.value = JSON.stringify(blob);
    };

    test('no pins by default', () => {
        expect(settings.getEntryPins('100')).toEqual({ boost: null, turbo: null });
    });

    test('pins a photo per feature, reads it back and clears it', () => {
        expect(settings.setEntryPin('boost', '100', 'img_a')).toBe(true);
        expect(settings.setEntryPin('turbo', '100', 'entry_007')).toBe(true);
        expect(settings.getEntryPins('100')).toEqual({ boost: 'img_a', turbo: 'entry_007' });
        // A numeric id addresses the same record.
        expect(settings.getEntryPins(invalid(100))).toEqual({ boost: 'img_a', turbo: 'entry_007' });

        expect(settings.setEntryPin('boost', '100', null)).toBe(true);
        expect(settings.getEntryPins('100')).toEqual({ boost: null, turbo: 'entry_007' });
    });

    test('an emptied record is dropped from the map', () => {
        settings.setEntryPin('boost', '100', 'img_a');
        settings.setEntryPin('boost', '100', null);
        const blob = parseJsonAs(store.value!, isAppSettings);
        expect(blob.challengeSettings.entryPins).toEqual({});
    });

    test('pinning a photo for one feature clears the other feature’s pin on it', () => {
        settings.setEntryPin('boost', '100', 'img_a');
        settings.setEntryPin('turbo', '100', 'img_a');
        expect(settings.getEntryPins('100')).toEqual({ boost: null, turbo: 'img_a' });
        settings.setEntryPin('boost', '100', 'img_a');
        expect(settings.getEntryPins('100')).toEqual({ boost: 'img_a', turbo: null });
    });

    test('a different photo for the other feature leaves both pins', () => {
        settings.setEntryPin('boost', '100', 'img_a');
        settings.setEntryPin('turbo', '100', 'img_b');
        expect(settings.getEntryPins('100')).toEqual({ boost: 'img_a', turbo: 'img_b' });
    });

    test('clearing a pin that was never set writes nothing and succeeds', () => {
        expect(settings.setEntryPin('turbo', '100', null)).toBe(true);
        expect(settings.getEntryPins('100')).toEqual({ boost: null, turbo: null });
    });

    test.each([['bogus'], [''], [null], [undefined], [42]])('refuses the feature %p', (kind) => {
        expect(settings.setEntryPin(invalid(kind), '100', 'img_a')).toBe(false);
        expect(store.write).not.toHaveBeenCalled();
    });

    test.each([[''], ['has space'], ['a'.repeat(65)], ['a\nb'], ['../x'], [42]])(
        'refuses the image id %p',
        (imageId) => {
            expect(settings.setEntryPin('boost', '100', invalid(imageId))).toBe(false);
            expect(store.write).not.toHaveBeenCalled();
        },
    );

    test.each([['__proto__'], ['constructor'], ['prototype'], ['   '], ['']])(
        'refuses the challenge id %p on set and get',
        (challengeId) => {
            expect(settings.setEntryPin('boost', challengeId, 'img_a')).toBe(false);
            expect(settings.getEntryPins(challengeId)).toEqual({ boost: null, turbo: null });
            expect(({} as { boost?: unknown }).boost).toBeUndefined();
            expect(({} as { turbo?: unknown }).turbo).toBeUndefined();
            expect(store.write).not.toHaveBeenCalled();
        },
    );

    test('a non-id challenge argument is refused', () => {
        expect(settings.setEntryPin('boost', invalid({}), 'img_a')).toBe(false);
        expect(settings.getEntryPins(invalid(null))).toEqual({ boost: null, turbo: null });
    });

    test('a prototype-named key in a hand-edited file never surfaces and is dropped on the next write', () => {
        tamper((pins) => {
            Object.defineProperty(pins, '__proto__', { value: { boost: 'evil' }, enumerable: true });
        });
        expect(settings.getEntryPins('seed')).toEqual({ boost: 'seedimg', turbo: null });
        expect(settings.setEntryPin('turbo', '100', 'img_b')).toBe(true);
        const saved = parseJsonAs(store.value!, isAppSettings).challengeSettings.entryPins;
        expect(Object.keys(saved).sort()).toEqual(['100', 'seed']);
    });

    test('a malformed single record reads as the valid parts only', () => {
        tamper((pins) => {
            pins.bad = { boost: 'has space', turbo: 'good_id' };
            pins.junk = 'not a record';
            pins.list = ['boost'];
            pins.numeric = { boost: 7 };
        });
        expect(settings.getEntryPins('bad')).toEqual({ boost: null, turbo: 'good_id' });
        expect(settings.getEntryPins('junk')).toEqual({ boost: null, turbo: null });
        expect(settings.getEntryPins('list')).toEqual({ boost: null, turbo: null });
        expect(settings.getEntryPins('numeric')).toEqual({ boost: null, turbo: null });
        // The next write keeps only the records that hold a valid pin.
        settings.setEntryPin('boost', '100', 'img_a');
        const saved = parseJsonAs(store.value!, isAppSettings).challengeSettings.entryPins;
        expect(Object.keys(saved).sort()).toEqual(['100', 'bad', 'seed']);
        expect(saved.bad).toEqual({ turbo: 'good_id' });
    });

    test('a prototype member name in the record is not a pin', () => {
        tamper((pins) => {
            pins.seed = Object.create({ boost: 'inherited' });
        });
        expect(settings.getEntryPins('seed')).toEqual({ boost: null, turbo: null });
    });

    test('a corrupt container is replaced by the empty default on load', () => {
        settings.setEntryPin('boost', '100', 'img_a');
        const blob = parseJsonAs(store.value!, isAppSettings);
        blob.challengeSettings.entryPins = invalid(['not', 'a', 'map']);
        store.value = JSON.stringify(blob);
        expect(settings.getEntryPins('100')).toEqual({ boost: null, turbo: null });
        expect(settings.setEntryPin('boost', '100', 'img_b')).toBe(true);
        expect(settings.getEntryPins('100')).toEqual({ boost: 'img_b', turbo: null });
    });

    test('returns false when the write fails', () => {
        store.write.mockImplementation(() => {
            throw new Error('disk full');
        });
        expect(settings.setEntryPin('boost', '100', 'img_a')).toBe(false);
    });

    describe('the map cap', () => {
        const fill = (count: number) => {
            for (let i = 0; i < count; i++) settings.setEntryPin('boost', `c${i}`, 'img_a');
        };

        test('refuses a new challenge over the cap, warns once, and still edits a known one', () => {
            fill(500);
            expect(settings.setEntryPin('boost', 'extra', 'img_a')).toBe(false);
            expect(settings.setEntryPin('turbo', 'extra2\nforged', 'img_a')).toBe(false);
            expect(mockWarning).toHaveBeenCalledTimes(1);
            expect(String(mockWarning.mock.calls[0][0])).toContain('pin cap of 500');
            expect(String(mockWarning.mock.calls[0][0])).not.toContain('\n');
            expect(settings.getEntryPins('extra')).toEqual({ boost: null, turbo: null });
            // A challenge already in the map is not "new": it still edits.
            expect(settings.setEntryPin('turbo', 'c0', 'img_b')).toBe(true);
        });

        test('the warning latch resets once the map is back under the cap', () => {
            fill(500);
            settings.setEntryPin('boost', 'extra', 'img_a');
            expect(mockWarning).toHaveBeenCalledTimes(1);
            settings.setEntryPin('boost', 'c0', null);
            expect(settings.setEntryPin('boost', 'extra', 'img_a')).toBe(true);
            settings.setEntryPin('boost', 'extra2', 'img_a');
            expect(mockWarning).toHaveBeenCalledTimes(2);
        });

        test('clearing at the cap is not blocked', () => {
            fill(500);
            expect(settings.setEntryPin('boost', 'c1', null)).toBe(true);
        });
    });

    describe('stale cleanup', () => {
        const seedPins = () => {
            settings.rememberChallengeTitles([{ id: 'live', title: 'Live' }]);
            settings.setEntryPin('boost', 'live', 'img_a');
            settings.setEntryPin('boost', 'old', 'img_a');
            settings.setEntryPin('turbo', 'older', 'img_b');
        };

        test('prunes the pins of challenges that are gone, including when only pins are stale', () => {
            seedPins();
            expect(settings.cleanupStaleChallengeSetting(['live'])).toBe(true);
            expect(settings.getEntryPins('live')).toEqual({ boost: 'img_a', turbo: null });
            expect(settings.getEntryPins('old')).toEqual({ boost: null, turbo: null });
            expect(settings.getEntryPins('older')).toEqual({ boost: null, turbo: null });
        });

        test('leaves everything and writes nothing when no pin is stale', () => {
            seedPins();
            settings.setEntryPin('boost', 'old', null);
            settings.setEntryPin('turbo', 'older', null);
            const writes = store.write.mock.calls.length;
            expect(settings.cleanupStaleChallengeSetting(['live'])).toBe(true);
            expect(store.write.mock.calls.length).toBe(writes);
        });
    });
});
