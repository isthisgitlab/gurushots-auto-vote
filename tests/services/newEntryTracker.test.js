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
    shouldRecordSnapshot,
    createMemoryEntryTracker,
    createMetadataEntryTracker,
} = require('../../src/js/services/newEntryTracker');
const metadata = require('../../src/js/metadata');
const logger = require('../../src/js/logger');

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

    test('bounds an oversized entries array before doing the work', () => {
        // The write-side caps in metadata would reject this only AFTER the traversal,
        // and reject it again every cycle since a rejected snapshot never settles.
        const huge = Array.from({ length: 500 }, (_, i) => ({ id: `id${i}` }));
        expect(readEntryIds(challengeWithEntries(huge))).toHaveLength(64);
    });

    test('drops ids longer than the per-id cap', () => {
        const ids = readEntryIds(challengeWithEntries([{ id: 'ok' }, { id: 'x'.repeat(65) }]));
        expect(ids).toEqual(['ok']);
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

describe('shouldRecordSnapshot', () => {
    test('records a normal non-empty snapshot', () => {
        expect(shouldRecordSnapshot(['a'], ['a', 'b'])).toBe(true);
        expect(shouldRecordSnapshot(null, ['a'])).toBe(true);
    });

    test('records an empty snapshot when there is no better baseline', () => {
        expect(shouldRecordSnapshot(null, [])).toBe(true);
        expect(shouldRecordSnapshot([], [])).toBe(true);
    });

    test('refuses to overwrite a non-empty baseline with an empty one', () => {
        // A poll returning [] for a challenge that had entries is indistinguishable
        // from a partial API response. Recording it would poison the baseline and
        // make the unchanged entries look brand new on the next poll.
        expect(shouldRecordSnapshot(['a', 'b'], [])).toBe(false);
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

describe('createMetadataEntryTracker — persistence outcome logging', () => {
    beforeEach(() => jest.clearAllMocks());
    afterEach(() => jest.restoreAllMocks());

    test('warns when metadata refuses the write, stays quiet when it succeeds', () => {
        const warning = jest.fn();
        jest.spyOn(logger, 'withCategory').mockReturnValue({ warning });
        const tracker = createMetadataEntryTracker();

        metadata.setChallengeEntryIds.mockReturnValueOnce(true);
        tracker.set('c1', ['a']);
        expect(warning).not.toHaveBeenCalled();

        metadata.setChallengeEntryIds.mockReturnValueOnce(false);
        tracker.set('c\n2', ['a']);
        expect(warning).toHaveBeenCalledTimes(1);
        // The API-sourced id is CR/LF-collapsed before interpolation.
        expect(warning.mock.calls[0][0]).not.toContain('\n');
        expect(warning.mock.calls[0][0]).toContain('Could not persist entry snapshot');
    });
});

describe('non-array guards', () => {
    test('hasNewEntries is false when the current ids are not an array', () => {
        expect(hasNewEntries(['a'], null)).toBe(false);
    });

    test('shouldRecordSnapshot refuses a non-array current snapshot', () => {
        expect(shouldRecordSnapshot(['a'], null)).toBe(false);
        expect(shouldRecordSnapshot(null, undefined)).toBe(false);
    });
});

describe('cap fallback when metadata exports are not finite', () => {
    afterEach(() => jest.restoreAllMocks());

    test('falls back to 64 for both caps and warns once per cap', () => {
        const warning = jest.fn();
        // The setup-level logger mock is already instantiated in the shared mock
        // registry, so an isolated doMock of it would be ignored — spy instead.
        jest.spyOn(logger, 'withCategory').mockReturnValue({ warning });
        // Same reason for mutating (and restoring) the shared metadata mock
        // rather than doMock-ing a replacement.
        const saved = { tracked: metadata.MAX_TRACKED_ENTRY_IDS, length: metadata.MAX_ENTRY_ID_LENGTH };
        metadata.MAX_TRACKED_ENTRY_IDS = undefined;
        metadata.MAX_ENTRY_ID_LENGTH = Number.NaN;
        try {
            jest.isolateModules(() => {
                const isolated = require('../../src/js/services/newEntryTracker');

                const entries = Array.from({ length: 70 }, (_, i) => ({ id: `e${i}` }));
                entries[0] = { id: 'x'.repeat(65) }; // over the fallback length cap → dropped
                const ids = isolated.readEntryIds({ member: { ranking: { entries } } });
                expect(ids).toHaveLength(63); // 64 kept by count, minus the over-long one
                expect(ids[0]).toBe('e1');
            });
        } finally {
            metadata.MAX_TRACKED_ENTRY_IDS = saved.tracked;
            metadata.MAX_ENTRY_ID_LENGTH = saved.length;
        }
        expect(warning).toHaveBeenCalledTimes(2);
        expect(warning.mock.calls[0][0]).toContain('MAX_TRACKED_ENTRY_IDS');
        expect(warning.mock.calls[1][0]).toContain('MAX_ENTRY_ID_LENGTH');
    });
});
