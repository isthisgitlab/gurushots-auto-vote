/**
 * Unit tests for getGroupApplicability — the pure helper that decides whether a
 * per-challenge settings GROUP can still take effect given the challenge's live
 * state. Terminal conditions only (boost/turbo USED, all entry slots full).
 */
import { getGroupApplicability } from '@/utils/challengeApplicability';

const challengeWith = (member, extra = {}) => ({ member, ...extra });

describe('getGroupApplicability', () => {
    test('no challenge → every group applicable', () => {
        for (const id of ['general', 'boost', 'turbo', 'lastHour', 'lastMinute', 'autoFill']) {
            expect(getGroupApplicability(id, null)).toEqual({ applicable: true, reasonKey: null });
        }
    });

    test('boost USED → boost group not applicable', () => {
        const challenge = challengeWith({ boost: { state: 'USED' } });
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naBoostUsed',
        });
    });

    test('boost AVAILABLE / UNAVAILABLE / LOCKED / missing → boost group applicable', () => {
        for (const state of ['AVAILABLE', 'AVAILABLE_KEY', 'UNAVAILABLE', 'LOCKED', undefined]) {
            const challenge = challengeWith({ boost: state ? { state } : {} });
            expect(getGroupApplicability('boost', challenge).applicable).toBe(true);
        }
    });

    test('boost LOCKED on a multi-photo challenge → applicable (LOCKED is transient, can still unlock)', () => {
        // The key distinction from the single-photo rule: on a >1 photo challenge a
        // LOCKED boost is "not unlocked yet" and may flip to AVAILABLE, so the group
        // must stay configurable.
        const challenge = challengeWith({ boost: { state: 'LOCKED' } }, { type: 'default', max_photo_submits: 2 });
        expect(getGroupApplicability('boost', challenge)).toEqual({ applicable: true, reasonKey: null });
    });

    test('flash challenge → boost group not applicable (even when boost is available)', () => {
        const challenge = challengeWith({ boost: { state: 'AVAILABLE' } }, { type: 'flash' });
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naFlashNoBoost',
        });
    });

    test('flash takes precedence over boost USED', () => {
        // Both hold (flash type AND boost used); the flash check is first, so
        // its reason must win.
        const challenge = challengeWith({ boost: { state: 'USED' } }, { type: 'flash' });
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naFlashNoBoost',
        });
    });

    test('boost: single-photo challenge (max 1) → not applicable, even with null entries (no throw)', () => {
        // A null `entries` value is a realistic API shape for a challenge with no
        // submissions; the single-photo check keys off max_photo_submits, not
        // entries, so it short-circuits without touching the (guarded) entries list.
        const challenge = challengeWith({ ranking: { entries: null } }, { type: 'default', max_photo_submits: 1 });
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naBoostSinglePhoto',
        });
    });

    test('boost: single-photo challenge (max 1) wins even if boost reads AVAILABLE → not applicable', () => {
        // Defensive: a single-photo challenge should keep boost LOCKED, but even if
        // the API ever reported AVAILABLE here, max_photo_submits === 1 is the
        // authoritative signal and still greys the group — the rule keys off photo
        // count, not boost.state.
        const challenge = challengeWith(
            { boost: { state: 'AVAILABLE' }, ranking: { entries: [{ id: '1' }] } },
            { type: 'default', max_photo_submits: 1 },
        );
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naBoostSinglePhoto',
        });
    });

    test('boost: single turboed entry but a free slot remains → applicable (could fill+boost a new photo)', () => {
        const challenge = challengeWith(
            { ranking: { entries: [{ id: '1', turbo: true }] } },
            { type: 'default', max_photo_submits: 2 },
        );
        expect(getGroupApplicability('boost', challenge).applicable).toBe(true);
    });

    test('boost: full slots but a non-turboed entry exists → applicable', () => {
        const challenge = challengeWith(
            {
                ranking: {
                    entries: [
                        { id: '1', turbo: true },
                        { id: '2', turbo: false },
                    ],
                },
            },
            { type: 'default', max_photo_submits: 2 },
        );
        expect(getGroupApplicability('boost', challenge).applicable).toBe(true);
    });

    test('boost: 1/1 with a non-turboed entry → not applicable (single photo never unlocks boost)', () => {
        // Even a non-turboed single entry can't be boosted: a single-photo
        // challenge never unlocks Boost at all (max_photo_submits === 1).
        const challenge = challengeWith(
            { ranking: { entries: [{ id: '1' }] } },
            { type: 'default', max_photo_submits: 1 },
        );
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naBoostSinglePhoto',
        });
    });

    test('boost: USED takes precedence over the single-photo rule', () => {
        // Both conditions hold (boost used AND single photo); the already-used
        // reason must win since it's checked first.
        const challenge = challengeWith(
            { boost: { state: 'USED' }, ranking: { entries: [{ id: '1' }] } },
            { type: 'default', max_photo_submits: 1 },
        );
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naBoostUsed',
        });
    });

    test('turbo USED → turbo group not applicable', () => {
        const challenge = challengeWith({ turbo: { state: 'USED' } });
        expect(getGroupApplicability('turbo', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naTurboUsed',
        });
    });

    test('turbo WON / FREE / TIMER / UNAVAILABLE → turbo group applicable', () => {
        for (const state of ['WON', 'FREE', 'TIMER', 'UNAVAILABLE', 'LOCKED']) {
            const challenge = challengeWith({ turbo: { state } });
            expect(getGroupApplicability('turbo', challenge).applicable).toBe(true);
        }
    });

    test('flash challenge → turbo group not applicable', () => {
        const challenge = challengeWith({ turbo: { state: 'WON' } }, { type: 'flash' });
        expect(getGroupApplicability('turbo', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naFlashNoTurbo',
        });
    });

    test('exhibition challenge → turbo group not applicable (boost stays available)', () => {
        const challenge = challengeWith(
            { turbo: { state: 'WON' }, boost: { state: 'AVAILABLE' } },
            { type: 'exhibition' },
        );
        expect(getGroupApplicability('turbo', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naExhibitionNoTurbo',
        });
        expect(getGroupApplicability('boost', challenge).applicable).toBe(true);
    });

    test('autoFill: all slots full → not applicable', () => {
        const challenge = challengeWith({ ranking: { entries: [{ id: '1' }, { id: '2' }] } }, { max_photo_submits: 2 });
        expect(getGroupApplicability('autoFill', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naSlotsFull',
        });
    });

    test('autoFill: more entries than max (defensive) → not applicable', () => {
        const challenge = challengeWith(
            { ranking: { entries: [{ id: '1' }, { id: '2' }, { id: '3' }] } },
            { max_photo_submits: 2 },
        );
        expect(getGroupApplicability('autoFill', challenge).applicable).toBe(false);
    });

    test('autoFill: slots remaining → applicable', () => {
        const challenge = challengeWith({ ranking: { entries: [{ id: '1' }] } }, { max_photo_submits: 3 });
        expect(getGroupApplicability('autoFill', challenge)).toEqual({ applicable: true, reasonKey: null });
    });

    test('autoFill: max_photo_submits unset (0) → applicable (cannot conclude full)', () => {
        const challenge = challengeWith({ ranking: { entries: [{ id: '1' }] } });
        expect(getGroupApplicability('autoFill', challenge).applicable).toBe(true);
    });

    test('autoFill: missing ranking/entries → applicable', () => {
        const challenge = challengeWith({}, { max_photo_submits: 2 });
        expect(getGroupApplicability('autoFill', challenge).applicable).toBe(true);
    });

    test('general / lastHour / lastMinute always applicable, even when boost used', () => {
        const challenge = challengeWith(
            { boost: { state: 'USED' }, turbo: { state: 'USED' } },
            { max_photo_submits: 1, ranking: { entries: [{ id: '1' }] } },
        );
        for (const id of ['general', 'lastHour', 'lastMinute']) {
            expect(getGroupApplicability(id, challenge)).toEqual({ applicable: true, reasonKey: null });
        }
    });

    test('unknown group → applicable', () => {
        expect(getGroupApplicability('nonexistent', challengeWith({ boost: { state: 'USED' } })).applicable).toBe(true);
    });
});
