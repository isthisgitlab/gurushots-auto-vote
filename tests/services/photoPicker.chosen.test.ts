/**
 * The user's chosen photos in the picker: the chosen block ranks first by the
 * ordinary scorer, entered ids drop out as a set, Submit Only judges the hard
 * filters on the chosen set alone, and enrichment runs per block.
 */

import { invalid } from '../helpers/invalid';
import type * as photoPickerModule from '../../src/ts/services/photoPicker';
import type { PickerPhoto, ScoredCandidate } from '../../src/ts/types/photoPicker';

const {
    pickPhotosForChallenge,
    buildScoredCandidates,
    buildChosenCandidates,
    finalizePick,
    selectBlockEnrichmentSet,
    selectEnrichmentSet,
    splitByChosen,
} = require('../../src/ts/services/photoPicker') as typeof photoPickerModule;

const photo = (id: string, labels: string[], uploadDate = 1000): PickerPhoto => ({
    id,
    labels,
    upload_date: uploadDate,
    permission: { allowed: true, message: null },
});

const challenge = { id: 'c1', title: 'Pink Flowers', url: 'pink-flowers1' };

// Two on-theme photos, two off-theme ones.
const library = [
    photo('theme-a', ['Pink', 'Flower'], 4000),
    photo('theme-b', ['Pink'], 3000),
    photo('off-a', ['Car'], 2000),
    photo('off-b', ['Tree'], 1000),
];

describe('chosen photos in the picker', () => {
    test('without chosen photos nothing differs from the plain scoring', () => {
        const plain = buildScoredCandidates(challenge, library, {});
        const viaChosen = buildChosenCandidates(challenge, library, {});
        expect(viaChosen.chosenIds).toBeNull();
        expect(viaChosen.scored).toEqual(plain);
        // An empty list is the same as no list, even with Only set.
        expect(buildChosenCandidates(challenge, library, { chosen: { ids: [], only: true } }).chosenIds).toBeNull();
        expect(buildChosenCandidates(challenge, library, { chosen: null }).scored).toEqual(plain);
        expect(finalizePick(plain, 2)).toEqual(finalizePick(plain, 2, null));
    });

    test('a list none of whose photos is usable has no chosen block, exactly like no list', () => {
        const plain = buildScoredCandidates(challenge, library, {});
        const { scored, chosenIds } = buildChosenCandidates(challenge, library, {
            chosen: { ids: ['missing'], only: false },
        });
        expect(chosenIds).toBeNull();
        expect(scored).toEqual(plain);
    });

    test('chosen photos rank first — ordered by the ordinary scorer — and the rest tops up', () => {
        const chosen = { ids: ['off-a', 'theme-b'], only: false };
        // theme-b outscores off-a inside the chosen block; then the best of the rest.
        expect(pickPhotosForChallenge(challenge, library, 3, { chosen })).toEqual(['theme-b', 'off-a', 'theme-a']);
        expect(pickPhotosForChallenge(challenge, library, 1, { chosen })).toEqual(['theme-b']);
        const { scored, chosenIds } = buildChosenCandidates(challenge, library, { chosen });
        expect(scored).toHaveLength(4);
        expect([...(chosenIds as ReadonlySet<string>)].sort()).toEqual(['off-a', 'theme-b']);
    });

    test('an id the library does not hold, or that is not allowed, is not in the chosen block', () => {
        const blocked = { ...photo('blocked', ['Pink']), permission: { allowed: false, message: 'used' } };
        const { chosenIds } = buildChosenCandidates(challenge, [...library, blocked], {
            chosen: { ids: ['blocked', 'missing', 'off-b'], only: false },
        });
        expect([...(chosenIds as ReadonlySet<string>)]).toEqual(['off-b']);
    });

    test('entered ids are removed from the pool as a set', () => {
        const chosen = { ids: ['theme-a', 'off-a'], only: false, excludeIds: new Set(['theme-a', 'off-b']) };
        const { scored, chosenIds } = buildChosenCandidates(challenge, library, { chosen });
        expect(scored.map((entry) => entry.id).sort()).toEqual(['off-a', 'theme-b']);
        expect([...(chosenIds as ReadonlySet<string>)]).toEqual(['off-a']);
        // A non-array pool is just empty.
        expect(buildChosenCandidates(challenge, invalid<PickerPhoto[]>(undefined), { chosen }).scored).toEqual([]);
    });

    test('with Only the pool holds nothing but the chosen photos', () => {
        const chosen = { ids: ['off-a'], only: true };
        expect(pickPhotosForChallenge(challenge, library, 3, { chosen })).toEqual(['off-a']);
        // No chosen photo usable: nothing is topped up.
        expect(pickPhotosForChallenge(challenge, library, 3, { chosen: { ids: ['gone'], only: true } })).toEqual([]);
    });

    test('Only judges the hard filters on the chosen set alone', () => {
        const options = { mustIncludeTags: ['Pink'], chosen: { ids: ['off-a'], only: true } };
        // The chosen photo lacks the required tag while other photos have it: it is
        // filtered out for good when relaxing is off, so nothing is picked...
        expect(pickPhotosForChallenge(challenge, library, 1, { ...options, fillWithoutTagMatch: false })).toEqual([]);
        // ...and when relaxing is on, it is relaxed on the chosen set — whether
        // the chosen photo is used never depends on unrelated photos.
        const relaxed = jest.fn();
        expect(pickPhotosForChallenge(challenge, library, 1, { ...options, onFallback: relaxed })).toEqual(['off-a']);
        expect(relaxed).toHaveBeenCalledTimes(1);
        // Without Only the whole pool is judged: the chosen photo that fails the
        // filter drops while other photos pass it.
        expect(
            pickPhotosForChallenge(challenge, library, 2, {
                mustIncludeTags: ['Pink'],
                chosen: { ids: ['off-a'], only: false },
            }),
        ).toEqual(['theme-a', 'theme-b']);
    });

    test('the two-stage finalizePick takes the whole chosen block before any top-up', () => {
        const scored = buildScoredCandidates(challenge, library, {});
        expect(finalizePick(scored, 4, new Set(['off-b', 'off-a']))).toEqual(['off-a', 'off-b', 'theme-a', 'theme-b']);
        expect(finalizePick(scored, 0, new Set(['off-b']))).toEqual([]);
        expect(finalizePick([], 2, new Set(['off-b']))).toEqual([]);
        expect(splitByChosen(scored, null)).toEqual({ chosen: [], rest: scored });
    });

    describe('enrichment per block', () => {
        // Seven tied candidates (no theme match at all): the tie decides enrichment.
        const tied = (ids: string[]): ScoredCandidate[] =>
            buildScoredCandidates(
                { title: 'Open Theme' },
                ids.map((id) => photo(id, ['Car'])),
                {},
            );

        test('a tie inside the chosen block is enriched, and the rest only gets the slots left', () => {
            const scored = tied(['c1', 'c2', 'c3', 'r1', 'r2', 'r3']);
            const chosenIds = new Set(['c1', 'c2', 'c3']);
            // want 2: both slots go to the chosen block, where three photos tie for them.
            const forTwo = selectBlockEnrichmentSet(scored, 2, chosenIds).map((p) => p.id);
            expect(forTwo.sort()).toEqual(['c1', 'c2', 'c3']);
            // want 4: the chosen block is fully taken (nothing contested), one slot is left for the rest.
            const forFour = selectBlockEnrichmentSet(scored, 4, chosenIds).map((p) => p.id);
            expect(forFour.sort()).toEqual(['r1', 'r2', 'r3']);
        });

        test('want minus the chosen count of zero enriches no rest photo', () => {
            const scored = tied(['c1', 'c2', 'r1', 'r2', 'r3']);
            expect(selectBlockEnrichmentSet(scored, 2, new Set(['c1', 'c2']))).toEqual([]);
        });

        test('without a chosen block it is the plain enrichment set', () => {
            const scored = tied(['a', 'b', 'c']);
            expect(selectBlockEnrichmentSet(scored, 1, null)).toEqual(selectEnrichmentSet(scored, 1));
        });
    });
});
