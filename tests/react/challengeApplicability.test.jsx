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

    test('boost: ranking.entries is null → applicable (|| [] guard, no throw)', () => {
        // Present `ranking` key with a null `entries` value is a realistic API
        // shape for a challenge with no submissions; the `|| []` guard must keep
        // entries.every / .length from throwing, leaving boost applicable at 1/1.
        const challenge = challengeWith({ ranking: { entries: null } }, { type: 'default', max_photo_submits: 1 });
        expect(getGroupApplicability('boost', challenge)).toEqual({ applicable: true, reasonKey: null });
    });

    test('boost: 1/1 slot filled by a turboed entry → not applicable (conflict, no room for a new entry)', () => {
        const challenge = challengeWith(
            { ranking: { entries: [{ id: '1', turbo: true }] } },
            { type: 'default', max_photo_submits: 1 },
        );
        expect(getGroupApplicability('boost', challenge)).toEqual({
            applicable: false,
            reasonKey: 'app.naBoostTurboConflict',
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

    test('boost: 1/1 with a non-turboed entry (turbo key absent) → applicable', () => {
        // Realistic API shape: a non-turboed photo simply omits the `turbo` key.
        // entries.every(e => e?.turbo) must read that as false → boost stays on.
        const challenge = challengeWith(
            { ranking: { entries: [{ id: '1' }] } },
            { type: 'default', max_photo_submits: 1 },
        );
        expect(getGroupApplicability('boost', challenge).applicable).toBe(true);
    });

    test('boost: USED takes precedence over the turbo conflict', () => {
        // Both conditions hold (boost used AND only entry is turboed); the
        // already-used reason must win since it's checked first.
        const challenge = challengeWith(
            { boost: { state: 'USED' }, ranking: { entries: [{ id: '1', turbo: true }] } },
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
