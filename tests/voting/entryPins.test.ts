/**
 * The pure pin reading shared by the Node-side picks and the renderer's pin controls: how a stored pin
 * matches the live entries, whether a feature can still fire, and which feature an entry is live-pinned for.
 */

import type * as entryPinsModule from '../../src/ts/voting/entryPins';
import type { Challenge, RankingEntry } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { findPinnedEntry, canStillFire, featureNeverFires, unusablePins, livePinKindOf } =
    require('../../src/ts/voting/entryPins') as typeof entryPinsModule;

const build = (
    entries: RankingEntry[],
    member: { boost?: Record<string, unknown>; turbo?: Record<string, unknown> } = {},
) => invalid<Challenge>({ id: 1, member: { ranking: { entries }, ...member } });

describe('findPinnedEntry', () => {
    test('none without a pin', () => {
        expect(findPinnedEntry(build([{ id: 'a' }]), 'boost', null)).toEqual({ state: 'none' });
    });

    test('hit returns the live entry, matched as strings', () => {
        const live = invalid<RankingEntry>({ id: 12 });
        expect(findPinnedEntry(build([{ id: 'a' }, live]), 'turbo', '12')).toEqual({ state: 'hit', entry: live });
    });

    test('gone when no entry has the id, or the challenge has no entries', () => {
        expect(findPinnedEntry(build([{ id: 'a' }]), 'boost', 'zzz')).toEqual({ state: 'gone' });
        expect(findPinnedEntry(invalid<Challenge>({ id: 1 }), 'boost', 'a')).toEqual({ state: 'gone' });
        expect(findPinnedEntry(invalid<Challenge>(null), 'boost', 'a')).toEqual({ state: 'gone' });
    });

    test('conflict when the photo carries the other feature', () => {
        expect(findPinnedEntry(build([{ id: 'a', turbo: true }]), 'boost', 'a')).toEqual({ state: 'conflict' });
        expect(findPinnedEntry(build([{ id: 'a', boosted: true }]), 'turbo', 'a')).toEqual({ state: 'conflict' });
        // Its own flag is not a conflict for the feature it belongs to.
        expect(findPinnedEntry(build([{ id: 'a', boosted: true }]), 'boost', 'a').state).toBe('hit');
    });
});

describe('canStillFire', () => {
    test.each([
        ['AVAILABLE', true],
        ['AVAILABLE_KEY', true],
        ['LOCKED', true],
        ['MISSED', true],
        ['USED', false],
        ['UNAVAILABLE', false],
    ])('Boost in state %s → %p', (state, expected) => {
        expect(canStillFire(build([{ id: 'a' }], { boost: { state } }), 'boost')).toBe(expected);
    });

    test.each([
        ['WON', true],
        ['FREE', true],
        ['TIMER', true],
        ['LOCKED', true],
        ['USED', false],
        ['UNAVAILABLE', false],
    ])('Turbo in state %s → %p', (state, expected) => {
        expect(canStillFire(build([{ id: 'a' }], { turbo: { state } }), 'turbo')).toBe(expected);
    });

    test('a feature already on an entry is spent', () => {
        expect(canStillFire(build([{ id: 'a', boosted: true }]), 'boost')).toBe(false);
        expect(canStillFire(build([{ id: 'a', turbo: true }]), 'turbo')).toBe(false);
        expect(canStillFire(build([{ id: 'a', turbo: true }]), 'boost')).toBe(true);
    });

    test('a payload without a member or entries can fire', () => {
        expect(canStillFire(invalid<Challenge>({ id: 1 }), 'boost')).toBe(true);
        expect(canStillFire(invalid<Challenge>(null), 'turbo')).toBe(true);
    });
});

describe('featureNeverFires', () => {
    const typed = (type: string, maxPhotoSubmits = 4) =>
        invalid<Challenge>({ id: 1, type, max_photo_submits: maxPhotoSubmits, member: {} });

    test.each([
        ['boost', 'flash', 4, 'flash'],
        ['boost', 'open', 1, 'single-photo'],
        ['boost', 'exhibition', 4, null],
        ['boost', 'open', 4, null],
        ['turbo', 'flash', 4, 'flash'],
        ['turbo', 'exhibition', 4, 'exhibition'],
        ['turbo', 'open', 1, null],
        ['turbo', 'open', 4, null],
    ] as const)('%s on a %s challenge with %i slot(s) → %p', (kind, type, slots, expected) => {
        expect(featureNeverFires(typed(type, slots), kind)).toBe(expected);
    });

    test('a payload without a type or a slot count can fire', () => {
        expect(featureNeverFires(invalid<Challenge>({ id: 1 }), 'boost')).toBeNull();
        expect(featureNeverFires(invalid<Challenge>(null), 'turbo')).toBeNull();
    });

    test('a feature that never fires cannot still fire, whatever its state', () => {
        expect(canStillFire(typed('flash'), 'boost')).toBe(false);
        expect(canStillFire(typed('flash'), 'turbo')).toBe(false);
        expect(canStillFire(typed('open', 1), 'boost')).toBe(false);
        expect(canStillFire(typed('exhibition'), 'turbo')).toBe(false);
        expect(canStillFire(typed('open', 1), 'turbo')).toBe(true);
        expect(canStillFire(typed('exhibition'), 'boost')).toBe(true);
    });

    test('a pin for such a feature is never live', () => {
        const entry = { id: 'a' };
        expect(livePinKindOf(typed('flash'), entry, { boost: 'a', turbo: null })).toBeNull();
        expect(livePinKindOf(typed('open', 1), entry, { boost: 'a', turbo: null })).toBeNull();
        expect(livePinKindOf(typed('exhibition'), entry, { boost: null, turbo: 'a' })).toBeNull();
        expect(livePinKindOf(typed('exhibition'), entry, { boost: 'a', turbo: null })).toBe('boost');
    });
});

describe('unusablePins', () => {
    test('lists a pin whose photo is gone, for each feature that can still fire', () => {
        expect(unusablePins(build([{ id: 'a' }]), { boost: 'zzz', turbo: 'yyy' })).toEqual([
            { kind: 'boost', state: 'gone' },
            { kind: 'turbo', state: 'gone' },
        ]);
    });

    test('lists a pin whose photo carries the other feature', () => {
        expect(unusablePins(build([{ id: 'a', turbo: true }]), { boost: 'a', turbo: null })).toEqual([
            { kind: 'boost', state: 'conflict' },
        ]);
        expect(unusablePins(build([{ id: 'a', boosted: true }]), { boost: null, turbo: 'a' })).toEqual([
            { kind: 'turbo', state: 'conflict' },
        ]);
    });

    test('lists nothing for a usable pin, no pin, or a spent feature', () => {
        expect(unusablePins(build([{ id: 'a' }]), { boost: 'a', turbo: null })).toEqual([]);
        expect(unusablePins(build([{ id: 'a' }], { boost: { state: 'USED' } }), { boost: 'zzz', turbo: null })).toEqual(
            [],
        );
    });
});

describe('livePinKindOf', () => {
    const pins = { boost: 'a', turbo: 'b' };

    test('names the feature an entry is pinned for', () => {
        const challenge = build([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        expect(livePinKindOf(challenge, { id: 'a' }, pins)).toBe('boost');
        expect(livePinKindOf(challenge, { id: 'b' }, pins)).toBe('turbo');
        expect(livePinKindOf(challenge, { id: 'c' }, pins)).toBeNull();
    });

    test('is null once the feature is spent, or the photo carries the other feature', () => {
        const spent = build([{ id: 'a' }, { id: 'b' }], { boost: { state: 'USED' } });
        expect(livePinKindOf(spent, { id: 'a' }, pins)).toBeNull();
        expect(livePinKindOf(spent, { id: 'b' }, pins)).toBe('turbo');
        const carriesTurbo = { id: 'a', turbo: true };
        expect(livePinKindOf(build([carriesTurbo]), carriesTurbo, pins)).toBeNull();
    });
});
