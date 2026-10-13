/**
 * The pure pin reading shared by the Node-side picks and the renderer's pin controls: how a stored pin
 * matches the live entries, whether a feature can still fire, and which feature an entry is live-pinned for.
 */

import type * as entryPinsModule from '../../src/ts/voting/entryPins';
import type { Challenge, RankingEntry } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { findPinnedEntry, canStillFire, livePinKindOf } =
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
