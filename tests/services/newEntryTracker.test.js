/**
 * Tests for the new-entry detection primitives behind the `voteOnNewEntry` setting.
 *
 * The two invariants worth pinning here are (a) a null previous snapshot NEVER
 * fires — otherwise a fresh install would vote on every pre-existing entry of
 * every challenge — and (b) every comparison is over sets, because the server can
 * reorder member.ranking.entries between polls with no membership change and a
 * positional compare would force a vote on every single cycle.
 */

const {
    readEntryIds,
    hasNewEntries,
    createMemoryEntryTracker,
    createMetadataEntryTracker,
} = require('../../src/js/services/newEntryTracker');
const metadata = require('../../src/js/metadata');

jest.mock('../../src/js/metadata');

const challengeWithEntries = (entries) => ({ member: { ranking: { entries } } });

describe('readEntryIds', () => {
    test('maps a normal entries array to string ids', () => {
        expect(readEntryIds(challengeWithEntries([{ id: 'a' }, { id: 'b' }]))).toEqual(['a', 'b']);
    });

    test('coerces numeric ids to strings', () => {
        expect(readEntryIds(challengeWithEntries([{ id: 101 }, { id: 202 }]))).toEqual(['101', '202']);
    });

    test('returns an empty array for a challenge with no entries', () => {
        expect(readEntryIds(challengeWithEntries([]))).toEqual([]);
    });

    test.each([
        ['missing member', {}],
        ['missing ranking', { member: {} }],
        ['missing entries', { member: { ranking: {} } }],
        ['entries is not an array', { member: { ranking: { entries: 'nope' } } }],
        ['null challenge', null],
        ['undefined challenge', undefined],
    ])('returns null when %s', (_label, challenge) => {
        expect(readEntryIds(challenge)).toBeNull();
    });

    test('drops malformed ids instead of stringifying them', () => {
        // A null id becoming the literal "undefined"/"null" would pollute the diff
        // set AND later trip the metadata validator, costing the whole snapshot.
        const challenge = challengeWithEntries([
            { id: 'good' },
            { id: null },
            { id: undefined },
            { id: '' },
            {},
            { id: 'also-good' },
        ]);
        expect(readEntryIds(challenge)).toEqual(['good', 'also-good']);
    });
});

describe('hasNewEntries', () => {
    test('null previous snapshot never fires (first sight is a baseline)', () => {
        expect(hasNewEntries(null, ['a', 'b'])).toBe(false);
        expect(hasNewEntries(undefined, ['a'])).toBe(false);
    });

    test('identical set does not fire', () => {
        expect(hasNewEntries(['a', 'b'], ['a', 'b'])).toBe(false);
    });

    test('same set in a different order does not fire', () => {
        expect(hasNewEntries(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(false);
    });

    test('an added id fires', () => {
        expect(hasNewEntries(['a'], ['a', 'b'])).toBe(true);
    });

    test('a removal alone does not fire', () => {
        expect(hasNewEntries(['a', 'b'], ['a'])).toBe(false);
        expect(hasNewEntries(['a', 'b'], [])).toBe(false);
    });

    test('a same-size swap fires', () => {
        expect(hasNewEntries(['a', 'b'], ['a', 'c'])).toBe(true);
    });

    test('an empty baseline is a real baseline, not a missing one', () => {
        expect(hasNewEntries([], [])).toBe(false);
        expect(hasNewEntries([], ['a'])).toBe(true);
    });
});

describe('createMemoryEntryTracker', () => {
    test('returns null before anything is stored, then the stored ids', () => {
        const tracker = createMemoryEntryTracker();
        expect(tracker.get('c1')).toBeNull();
        tracker.set('c1', ['a']);
        expect(tracker.get('c1')).toEqual(['a']);
    });

    test('distinguishes a stored empty array from an absent snapshot', () => {
        const tracker = createMemoryEntryTracker();
        tracker.set('c1', []);
        expect(tracker.get('c1')).toEqual([]);
        expect(tracker.get('c2')).toBeNull();
    });

    test('keeps challenges independent and copies the stored array', () => {
        const tracker = createMemoryEntryTracker();
        const ids = ['a'];
        tracker.set('c1', ids);
        ids.push('mutated-after-store');
        expect(tracker.get('c1')).toEqual(['a']);
        expect(tracker.get('c2')).toBeNull();
    });

    test('never touches metadata.json', () => {
        const tracker = createMemoryEntryTracker();
        tracker.set('c1', ['a']);
        tracker.get('c1');
        expect(metadata.setChallengeEntryIds).not.toHaveBeenCalled();
        expect(metadata.getChallengeEntryIds).not.toHaveBeenCalled();
    });
});

describe('createMetadataEntryTracker', () => {
    beforeEach(() => jest.clearAllMocks());

    test('delegates reads and writes to the metadata store', () => {
        metadata.getChallengeEntryIds.mockReturnValue(['a']);
        const tracker = createMetadataEntryTracker();

        expect(tracker.get('c1')).toEqual(['a']);
        expect(metadata.getChallengeEntryIds).toHaveBeenCalledWith('c1');

        tracker.set('c1', ['a', 'b']);
        expect(metadata.setChallengeEntryIds).toHaveBeenCalledWith('c1', ['a', 'b']);
    });
});
