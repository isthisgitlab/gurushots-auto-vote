/**
 * Tests for challengeTitlePin.js — first-seen title pinning applied to
 * freshly fetched active-challenge lists.
 *
 * The settings facade is a STATEFUL fake (not static mockReturnValue stubs):
 * getTitlePins/mergeTitlePins are wired against a shared in-test object so
 * call N's write is visible to call N+1's read — the multi-call scenarios
 * (overwrite, prune, change-gated writes) only exercise the real branches
 * with visible prior state.
 */

// Shared mutable pin store backing the settings-facade fake.
let pinStore = {};

jest.mock('../../src/js/settings', () => ({
    getTitlePins: jest.fn(() => ({ ...pinStore })),
    mergeTitlePins: jest.fn((adds, removeIds) => {
        for (const id of removeIds || []) {
            delete pinStore[id];
        }
        for (const [id, title] of Object.entries(adds || {})) {
            if (!Object.prototype.hasOwnProperty.call(pinStore, id)) {
                pinStore[id] = title;
            }
        }
        return true;
    }),
}));

const mockWarning = jest.fn();
jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        warning: mockWarning,
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
    })),
}));

const settings = require('../../src/js/settings');
const { pinChallengeTitles, __resetForTests } = require('../../src/js/services/challengeTitlePin');

describe('pinChallengeTitles', () => {
    beforeEach(() => {
        pinStore = {};
        jest.clearAllMocks();
        __resetForTests();
    });

    test('first fetch pins trimmed-non-empty titles and passes them through untouched', () => {
        const challenges = [
            { id: '1', title: 'Pink In Nature' },
            { id: '2', title: '   ' }, // whitespace-only — not pinned
            { id: '3' }, // no title — not pinned
        ];

        const result = pinChallengeTitles(challenges);

        expect(result).toBe(challenges);
        expect(result[0].title).toBe('Pink In Nature');
        expect(pinStore).toEqual({ 1: 'Pink In Nature' });
        expect(mockWarning).not.toHaveBeenCalled();
    });

    test('unchanged titles on a later call cause no write', () => {
        pinChallengeTitles([{ id: '1', title: 'Pink In Nature' }]);
        settings.mergeTitlePins.mockClear();

        pinChallengeTitles([{ id: '1', title: 'Pink In Nature' }]);

        expect(settings.mergeTitlePins).not.toHaveBeenCalled();
    });

    test('server-side rename is overwritten with the pinned title', () => {
        pinChallengeTitles([{ id: '1', title: 'Pink In Nature' }]);

        const renamed = [{ id: '1', title: 'turbo' }];
        pinChallengeTitles(renamed);

        expect(renamed[0].title).toBe('Pink In Nature');
        expect(pinStore).toEqual({ 1: 'Pink In Nature' });
    });

    test('warning logged once per distinct incoming title, again for a new value', () => {
        pinChallengeTitles([{ id: '1', title: 'Pink In Nature' }]);

        pinChallengeTitles([{ id: '1', title: 'turbo' }]);
        pinChallengeTitles([{ id: '1', title: 'turbo' }]);
        expect(mockWarning).toHaveBeenCalledTimes(1);
        expect(mockWarning.mock.calls[0][0]).toContain('Title pin: ignoring server rename for challenge 1');

        pinChallengeTitles([{ id: '1', title: 'swap' }]);
        expect(mockWarning).toHaveBeenCalledTimes(2);
    });

    test('missing/empty/whitespace title with an existing pin is restored', () => {
        pinChallengeTitles([{ id: '1', title: 'Pink In Nature' }]);

        for (const title of [undefined, '', '   ']) {
            const list = [{ id: '1', title }];
            pinChallengeTitles(list);
            expect(list[0].title).toBe('Pink In Nature');
        }
        // Restoring is not a rename — no warning.
        expect(mockWarning).not.toHaveBeenCalled();
    });

    test('numeric and string ids share one pin; entries without an id are skipped', () => {
        pinChallengeTitles([{ id: 123, title: 'Numeric First' }, { title: 'No Id' }, { id: null, title: 'Null Id' }]);

        expect(pinStore).toEqual({ 123: 'Numeric First' });
        expect(Object.keys(pinStore)).not.toContain('undefined');
        expect(Object.keys(pinStore)).not.toContain('null');

        const renamed = [{ id: '123', title: 'renamed' }];
        pinChallengeTitles(renamed);
        expect(renamed[0].title).toBe('Numeric First');
    });

    test('pruning: id absent from a non-empty list loses its pin; re-appearing id re-pins', () => {
        pinChallengeTitles([
            { id: '1', title: 'Keep Me' },
            { id: '2', title: 'Drop Me' },
        ]);

        pinChallengeTitles([{ id: '1', title: 'Keep Me' }]);
        expect(pinStore).toEqual({ 1: 'Keep Me' });

        const reappeared = [
            { id: '1', title: 'Keep Me' },
            { id: '2', title: 'Fresh Title' },
        ];
        pinChallengeTitles(reappeared);
        expect(pinStore).toEqual({ 1: 'Keep Me', 2: 'Fresh Title' });
        expect(reappeared[1].title).toBe('Fresh Title');
    });

    test('empty list and non-array input prune nothing and touch nothing', () => {
        pinChallengeTitles([{ id: '1', title: 'Pink In Nature' }]);
        settings.mergeTitlePins.mockClear();
        settings.getTitlePins.mockClear();

        expect(pinChallengeTitles([])).toEqual([]);
        expect(pinChallengeTitles(null)).toBe(null);
        expect(pinChallengeTitles(undefined)).toBe(undefined);

        expect(settings.getTitlePins).not.toHaveBeenCalled();
        expect(settings.mergeTitlePins).not.toHaveBeenCalled();
        expect(pinStore).toEqual({ 1: 'Pink In Nature' });
    });

    test('mergeTitlePins is called only when the pin set changed, with the right adds/removeIds', () => {
        pinChallengeTitles([
            { id: '1', title: 'One' },
            { id: '2', title: 'Two' },
        ]);
        expect(settings.mergeTitlePins).toHaveBeenCalledTimes(1);
        expect(settings.mergeTitlePins).toHaveBeenCalledWith({ 1: 'One', 2: 'Two' }, []);

        settings.mergeTitlePins.mockClear();
        pinChallengeTitles([
            { id: '1', title: 'One' },
            { id: '3', title: 'Three' },
        ]);
        expect(settings.mergeTitlePins).toHaveBeenCalledTimes(1);
        expect(settings.mergeTitlePins).toHaveBeenCalledWith({ 3: 'Three' }, ['2']);

        settings.mergeTitlePins.mockClear();
        pinChallengeTitles([
            { id: '1', title: 'One' },
            { id: '3', title: 'Three' },
        ]);
        expect(settings.mergeTitlePins).not.toHaveBeenCalled();
    });

    test('over-length titles are bounded before compare and store (no perpetual mismatch)', () => {
        const long = 'x'.repeat(250);
        const bounded = 'x'.repeat(200);

        pinChallengeTitles([{ id: '1', title: long }]);
        expect(pinStore).toEqual({ 1: bounded });

        mockWarning.mockClear();
        const again = [{ id: '1', title: long }];
        pinChallengeTitles(again);
        expect(mockWarning).not.toHaveBeenCalled();
        expect(again[0].title).toBe(long); // matches its pin — left as-is
    });

    test('pins survive an interleaved failed fetch (no call between successes)', () => {
        pinChallengeTitles([{ id: '1', title: 'Pink In Nature' }]);

        // A failed fetch returns { challenges: [] } before the hook — the pin
        // module is simply not called. The next successful fetch must still
        // restore against the surviving pin.
        const next = [{ id: '1', title: 'turbo' }];
        pinChallengeTitles(next);
        expect(next[0].title).toBe('Pink In Nature');
    });
});
