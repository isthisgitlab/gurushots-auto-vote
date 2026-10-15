/**
 * The photo pinned for Boost or Turbo on the decision layer: how a pin resolves
 * against the live entries, what it beats, how it blocks the other feature's
 * spend (and when it gives way), and the deadline preview that reads the same pick.
 */

jest.mock('../../src/ts/settings');

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as VotingLogicModule from '../../src/ts/services/VotingLogic';
import type * as entryPickModule from '../../src/ts/services/decisions/entryPick';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { Challenge, RankingEntry } from '../../src/ts/types/gurushots';
import type { EntryPins } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';
const VotingLogic = require('../../src/ts/services/VotingLogic') as typeof VotingLogicModule;
const { pinReleaseAt } = require('../../src/ts/services/decisions/entryPick') as typeof entryPickModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

const CLOSE = 1_000_000;
const NOW = CLOSE - 100;

const setup = (pins: Partial<EntryPins> = {}, values: Record<string, unknown> = {}) => {
    const merged: Record<string, unknown> = {
        boostImageIndex: 1,
        turboImageIndex: 1,
        turboTime: 7200,
        boostTime: 3600,
        keyUnlockedBoostTime: 900,
        autoBoost: true,
        useTurbo: true,
        autoSubmit: false,
        emergencySubmit: 0,
        autoSubmitSchedule: [],
        mustIncludeTags: [],
        ...values,
    };
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null, ...pins });
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => merged[key]));
    settings.getEffectiveTagSetting = invalid(jest.fn((key: string) => merged[key]));
};

const build = (
    entries: RankingEntry[],
    { boost = { state: 'AVAILABLE_KEY' }, turbo = { state: 'WON' } }: Record<string, Record<string, unknown>> = {},
): Challenge =>
    buildChallenge({
        id: '42',
        close_time: CLOSE,
        max_photo_submits: entries.length + 1,
        member: { boost, turbo, ranking: { entries } },
    });

const A = { id: 'aaa' };
const B = { id: 'bbb' };
const C = { id: 'ccc' };

beforeEach(() => jest.clearAllMocks());

describe('resolvePin', () => {
    test('none without a pin', () => {
        setup();
        expect(VotingLogic.resolvePin(build([A, B]), '42', 'boost')).toEqual({ state: 'none' });
    });

    test('hit carries the live entry, matched as strings', () => {
        setup({ boost: '7' });
        const live = { id: 7, rank: 3 };
        expect(VotingLogic.resolvePin(build([A, invalid(live)]), '42', 'boost')).toEqual({
            state: 'hit',
            entry: live,
        });
    });

    test('gone when the photo is no longer an entry, or there are no entries', () => {
        setup({ boost: 'zzz' });
        expect(VotingLogic.resolvePin(build([A, B]), '42', 'boost')).toEqual({ state: 'gone' });
        expect(VotingLogic.resolvePin(invalid({ id: '42' }), '42', 'boost')).toEqual({ state: 'gone' });
    });

    test('conflict when the photo carries the other feature', () => {
        setup({ boost: 'aaa', turbo: 'bbb' });
        const challenge = build([
            { id: 'aaa', turbo: true },
            { id: 'bbb', boosted: true },
        ]);
        expect(VotingLogic.resolvePin(challenge, '42', 'boost')).toEqual({ state: 'conflict' });
        expect(VotingLogic.resolvePin(challenge, '42', 'turbo')).toEqual({ state: 'conflict' });
    });
});

describe('pickBoostEntry with a pin', () => {
    test('a usable pin names the entry, wherever the server sorts it', () => {
        setup({ boost: 'ccc' });
        // The pin is on a non-slot-1 entry in every ordering, so a positional pick cannot pass by accident.
        for (const order of [
            [A, B, C],
            [C, A, B],
            [B, C, A],
            [A, C, B],
        ]) {
            expect(VotingLogic.pickBoostEntry(build(order), '42', NOW)?.id).toBe('ccc');
        }
    });

    test('a pin beats boostImageIndex', () => {
        setup({ boost: 'bbb' }, { boostImageIndex: 3 });
        expect(VotingLogic.pickBoostEntry(build([A, B, C]), '42', NOW)?.id).toBe('bbb');
    });

    test('a gone pin falls back to the slot pick', () => {
        setup({ boost: 'zzz' }, { boostImageIndex: 2 });
        expect(VotingLogic.pickBoostEntry(build([A, B, C]), '42', NOW)?.id).toBe('bbb');
    });

    test('a conflicting pin falls back to the slot pick', () => {
        setup({ boost: 'aaa' }, { boostImageIndex: 1 });
        const entries = [{ id: 'aaa', turbo: true }, B];
        expect(VotingLogic.pickBoostEntry(build(entries), '42', NOW)?.id).toBe('bbb');
    });

    test('no entries is still null', () => {
        setup({ boost: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([]), '42', NOW)).toBeNull();
    });

    test('null still means every candidate carries Turbo', () => {
        setup({ turbo: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([{ id: 'aaa', turbo: true }]), '42', NOW)).toBeNull();
    });
});

describe('the slot pick avoids the photo the other feature is pinned to', () => {
    test('Turbo steers off the photo pinned for Boost (default turboImageIndex=1)', () => {
        setup({ boost: 'aaa' });
        const decision = VotingLogic.shouldApplyTurbo(build([A, B]), NOW);
        expect(decision).toMatchObject({ apply: true, imageId: 'bbb', fillNew: false });
    });

    test('Boost steers off the photo pinned for Turbo (default boostImageIndex=1)', () => {
        setup({ turbo: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([A, B]), '42', NOW)?.id).toBe('bbb');
    });

    test('pickEntryAvoidingConflict walks past the flagged entry and the avoided photo', () => {
        const entries = [A, B, { id: 'ccc', boosted: true }];
        expect(VotingLogic.pickEntryAvoidingConflict(entries, 1, 'boosted', 'aaa')?.id).toBe('bbb');
        expect(VotingLogic.pickEntryAvoidingConflict(entries, 1, 'boosted')?.id).toBe('aaa');
    });

    test('an avoided photo with no other candidate leaves null — the pin is a hard exclusion', () => {
        expect(VotingLogic.pickEntryAvoidingConflict([A], 1, 'boosted', 'aaa')).toBeNull();
        expect(
            VotingLogic.pickEntryAvoidingConflict([A, { id: 'bbb', boosted: true }], 1, 'boosted', 'aaa'),
        ).toBeNull();
    });

    test('null also means every candidate carries the flag, avoided photo or not', () => {
        expect(VotingLogic.pickEntryAvoidingConflict([{ id: 'aaa', boosted: true }], 1, 'boosted', 'aaa')).toBeNull();
    });

    test('the fill-new fallback target steers off the Boost pin too', () => {
        setup({ boost: 'aaa' }, { turboNewSubmit: true });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), NOW)).toMatchObject({
            apply: true,
            fillNew: true,
            imageId: 'bbb',
        });
    });
});

describe('a live pin blocks the other feature’s spend', () => {
    test('two entries, Boost pinned on A and spent on B: Turbo lands on A (the pin is inert once spent)', () => {
        setup({ boost: 'aaa' });
        const challenge = build([A, { id: 'bbb', boosted: true }], { boost: { state: 'USED' } });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW)).toMatchObject({ apply: true, imageId: 'aaa' });
    });

    test('two entries, Turbo pinned on A and applied to B: Boost lands on A (the pin is inert once spent)', () => {
        setup({ turbo: 'aaa' });
        const challenge = build([A, { id: 'bbb', turbo: true }], { turbo: { state: 'USED' } });
        expect(VotingLogic.pickBoostEntry(challenge, '42', NOW)?.id).toBe('aaa');
    });

    test('one entry with a Turbo pin and Turbo never won: Boost is blocked and resolves to a conflict', () => {
        setup({ turbo: 'aaa' }, { boostNewSubmitOnConflict: true });
        const challenge = build([A], { turbo: { state: 'LOCKED' } });
        expect(VotingLogic.pickBoostEntry(challenge, '42', NOW)).toBeNull();
        expect(VotingLogic.resolveBoostFillNewMode(challenge, '42')).toBe('conflict');
    });

    test('one entry with a Boost pin: Turbo is blocked and resolves to a conflict', () => {
        setup({ boost: 'aaa' }, { turboNewSubmitOnConflict: true });
        const challenge = build([A]);
        expect(VotingLogic.pickTurboEntry(challenge, '42', NOW)).toBeNull();
        expect(VotingLogic.resolveTurboFillNewMode(challenge, '42')).toBe('conflict');
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW)).toMatchObject({
            apply: true,
            fillNew: true,
            imageId: null,
            reason: 'eligible (fill-new on conflict)',
        });
    });

    test('without the conflict option the blocked spend is a noop, never landing on the pinned photo', () => {
        setup({ boost: 'aaa' });
        expect(VotingLogic.shouldApplyTurbo(build([A]), NOW)).toMatchObject({
            apply: false,
            imageId: null,
            reason: 'every entry has Boost or is pinned for Boost',
        });
        setup({ turbo: 'aaa' });
        const challenge = build([A], { turbo: { state: 'LOCKED' } });
        expect(VotingLogic.pickBoostEntry(challenge, '42', NOW)).toBeNull();
        expect(VotingLogic.resolveBoostFillNewMode(challenge, '42')).toBe('no');
    });

    test('Manual Photos Only never fills a fresh photo to resolve the conflict', () => {
        setup(
            { turbo: 'aaa' },
            { boostNewSubmitOnConflict: true, turboNewSubmitOnConflict: true, manualPhotosOnly: true },
        );
        expect(VotingLogic.resolveBoostFillNewMode(build([A], { turbo: { state: 'LOCKED' } }), '42')).toBe('no');
        setup({ boost: 'aaa' }, { turboNewSubmitOnConflict: true, manualPhotosOnly: true });
        expect(VotingLogic.resolveTurboFillNewMode(build([A]), '42')).toBe('no');
    });

    test('with a second entry the pick steps off the pinned photo', () => {
        setup({ turbo: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([A, B], { turbo: { state: 'LOCKED' } }), '42', NOW)?.id).toBe('bbb');
        setup({ boost: 'aaa' });
        expect(VotingLogic.pickTurboEntry(build([A, B]), '42', NOW)?.id).toBe('bbb');
    });

    test('a gone pin and a spent pin block nothing', () => {
        setup({ turbo: 'zzz' });
        expect(VotingLogic.pickBoostEntry(build([A]), '42', NOW)?.id).toBe('aaa');
        setup({ turbo: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([A], { turbo: { state: 'USED' } }), '42', NOW)?.id).toBe('aaa');
        setup({ boost: 'zzz' });
        expect(VotingLogic.pickTurboEntry(build([A]), '42', NOW)?.id).toBe('aaa');
        setup({ boost: 'aaa' });
        expect(VotingLogic.pickTurboEntry(build([A], { boost: { state: 'USED' } }), '42', NOW)?.id).toBe('aaa');
    });

    test('two entries pinned for different features each get their own', () => {
        setup({ boost: 'aaa', turbo: 'bbb' });
        const challenge = build([A, B]);
        expect(VotingLogic.pickBoostEntry(challenge, '42', NOW)?.id).toBe('aaa');
        expect(VotingLogic.pickTurboEntry(challenge, '42', NOW)?.id).toBe('bbb');
    });

    test('the only entry already carrying the other flag is a noop with the blocked-spend reason', () => {
        setup({ boost: 'aaa' });
        const challenge = build([{ id: 'aaa', boosted: true }]);
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW)).toMatchObject({
            apply: false,
            reason: 'every entry has Boost or is pinned for Boost',
        });
    });
});

describe('a blocking pin gives way at the buzzer', () => {
    const turboNotWon = { turbo: { state: 'LOCKED' } };
    const insideWindow = CLOSE - 100;
    const outsideWindow = CLOSE - 1000;

    test('Boost lands on the Turbo-pinned photo once inside Emergency Fill with Turbo not won', () => {
        setup({ turbo: 'aaa' }, { emergencySubmit: 300 });
        const challenge = build([A], turboNotWon);
        expect(VotingLogic.pickBoostEntry(challenge, '42', insideWindow)?.id).toBe('aaa');
        expect(VotingLogic.pickBoostEntry(challenge, '42', outsideWindow)).toBeNull();
    });

    describe('a pin that has given way is a preference, not a free-for-all', () => {
        const boostLocked = { boost: { state: 'LOCKED' } };

        test('Boost with a free entry still steers off the Turbo pin inside the window', () => {
            setup({ turbo: 'aaa' }, { emergencySubmit: 300 });
            const challenge = build([A, B], turboNotWon);
            expect(VotingLogic.pickBoostEntry(challenge, '42', insideWindow)?.id).toBe('bbb');
            expect(VotingLogic.pickBoostEntry(challenge, '42', outsideWindow)?.id).toBe('bbb');
        });

        test('Turbo with a free entry still steers off the Boost pin inside the window', () => {
            setup({ boost: 'aaa' }, { emergencySubmit: 300 });
            const challenge = build([A, B], boostLocked);
            expect(VotingLogic.pickTurboEntry(challenge, '42', insideWindow)?.id).toBe('bbb');
            expect(VotingLogic.shouldApplyTurbo(challenge, insideWindow, { emergency: true })).toMatchObject({
                apply: true,
                imageId: 'bbb',
                fillNew: false,
            });
        });

        test('Boost: one entry pinned, a free slot, fill-on-conflict: a fresh photo is preferred inside the window', () => {
            setup({ turbo: 'aaa' }, { emergencySubmit: 300, boostNewSubmitOnConflict: true });
            const challenge = build([A], turboNotWon);
            expect(VotingLogic.resolveBoostFillNewMode(challenge, '42')).toBe('conflict');
            // A failed fill falls back to the pinned photo, which the pick now offers.
            expect(VotingLogic.pickBoostEntry(challenge, '42', insideWindow)?.id).toBe('aaa');
            expect(VotingLogic.pickBoostEntry(challenge, '42', outsideWindow)).toBeNull();
        });

        test('Turbo: one entry pinned, a free slot, fill-on-conflict: fill-new with the pinned photo as the fallback', () => {
            setup({ boost: 'aaa' }, { emergencySubmit: 300, turboNewSubmitOnConflict: true });
            const challenge = build([A], boostLocked);
            expect(VotingLogic.resolveTurboFillNewMode(challenge, '42')).toBe('conflict');
            expect(VotingLogic.shouldApplyTurbo(challenge, insideWindow, { emergency: true })).toEqual({
                apply: true,
                imageId: 'aaa',
                fillNew: true,
                reason: 'eligible (fill-new on conflict)',
            });
            // Before the release there is no fallback: the runner skips rather than turbo the pinned photo.
            expect(VotingLogic.shouldApplyTurbo(challenge, outsideWindow, { emergency: true })).toMatchObject({
                fillNew: true,
                imageId: null,
            });
        });

        test('without the on-conflict option the pinned photo takes the spend once it has given way', () => {
            setup({ boost: 'aaa' }, { emergencySubmit: 300 });
            expect(VotingLogic.resolveTurboFillNewMode(build([A], boostLocked), '42')).toBe('no');
            expect(
                VotingLogic.shouldApplyTurbo(build([A], boostLocked), insideWindow, { emergency: true }),
            ).toMatchObject({
                apply: true,
                imageId: 'aaa',
                fillNew: false,
                reason: 'eligible',
            });
        });
    });

    test('a ready pin (Turbo WON) keeps blocking inside the window', () => {
        setup({ turbo: 'aaa' }, { emergencySubmit: 300 });
        expect(VotingLogic.pickBoostEntry(build([A]), '42', insideWindow)).toBeNull();
    });

    test('with Emergency Fill off the pin never gives way', () => {
        setup({ turbo: 'aaa' }, { emergencySubmit: 0 });
        expect(VotingLogic.pickBoostEntry(build([A], turboNotWon), '42', CLOSE - 1)).toBeNull();
        expect(pinReleaseAt(build([A], turboNotWon), '42', 'turbo', outsideWindow)).toBeNull();
    });

    test('a timer Boost releases by its own timeout, not the challenge close', () => {
        setup({ turbo: 'aaa' }, { emergencySubmit: 300 });
        const timer = (timeout: number) => build([A], { boost: { state: 'AVAILABLE', timeout }, ...turboNotWon });
        const timeout = CLOSE - 5000;
        // 1000 s to the timeout: still blocked, though the challenge is far from over either way.
        expect(VotingLogic.pickBoostEntry(timer(timeout), '42', timeout - 1000)).toBeNull();
        // 200 s to the timeout: inside Emergency Fill although the close is 5200 s away.
        expect(VotingLogic.pickBoostEntry(timer(timeout), '42', timeout - 200)?.id).toBe('aaa');
        expect(pinReleaseAt(timer(timeout), '42', 'turbo', timeout - 1000)).toBe(timeout - 300);
    });

    test('Turbo lands on the Boost-pinned photo once inside Emergency Fill with Boost not ready', () => {
        setup({ boost: 'aaa' }, { emergencySubmit: 300 });
        const boostLocked = { boost: { state: 'LOCKED' } };
        expect(VotingLogic.pickTurboEntry(build([A], boostLocked), '42', insideWindow)?.id).toBe('aaa');
        expect(VotingLogic.pickTurboEntry(build([A], boostLocked), '42', outsideWindow)).toBeNull();
        expect(VotingLogic.shouldApplyTurbo(build([A], boostLocked), insideWindow, { emergency: true })).toMatchObject({
            apply: true,
            imageId: 'aaa',
        });
    });

    test('a ready Boost pin (window open) keeps blocking Turbo inside the window', () => {
        setup({ boost: 'aaa' }, { emergencySubmit: 300 });
        expect(VotingLogic.pickTurboEntry(build([A]), '42', insideWindow)).toBeNull();
    });

    test('pinReleaseAt names the instant it gives way, and nothing when nothing blocks or it never does', () => {
        setup({ turbo: 'aaa' }, { emergencySubmit: 300 });
        const challenge = build([A], turboNotWon);
        expect(pinReleaseAt(challenge, '42', 'turbo', outsideWindow)).toBe(CLOSE - 300);
        // already released, no pin for the kind, a ready pin, a missing close time, a deadline already past
        expect(pinReleaseAt(challenge, '42', 'turbo', insideWindow)).toBeNull();
        expect(pinReleaseAt(challenge, '42', 'boost', outsideWindow)).toBeNull();
        expect(pinReleaseAt(build([A]), '42', 'turbo', outsideWindow)).toBeNull();
        expect(pinReleaseAt(invalid({ ...challenge, close_time: undefined }), '42', 'turbo', NOW)).toBeNull();
        expect(pinReleaseAt(challenge, '42', 'turbo', CLOSE + 10)).toBeNull();
    });
});

describe('a spent feature’s pin is inert', () => {
    test.each([
        ['Boost state USED', { boost: { state: 'USED' } }, [A, B]],
        ['Boost state UNAVAILABLE', { boost: { state: 'UNAVAILABLE' } }, [A, B]],
        ['Boost already on an entry', {}, [A, { id: 'bbb', boosted: true }]],
    ])('Boost pin: %s does not steer Turbo', (_name, states, entries) => {
        setup({ boost: 'aaa' });
        expect(VotingLogic.shouldApplyTurbo(build(entries, states), NOW).imageId).toBe('aaa');
    });

    test.each([
        ['Turbo state USED', { turbo: { state: 'USED' } }, [A, B]],
        ['Turbo state UNAVAILABLE', { turbo: { state: 'UNAVAILABLE' } }, [A, B]],
        ['Turbo already on an entry', {}, [A, { id: 'bbb', turbo: true }]],
    ])('Turbo pin: %s does not steer Boost', (_name, states, entries) => {
        setup({ turbo: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build(entries, states), '42', NOW)?.id).toBe('aaa');
    });

    test('livePinnedIds lists only the pins whose feature can still fire', () => {
        setup({ boost: 'aaa', turbo: 'bbb' });
        expect(VotingLogic.livePinnedIds(build([A, B]), '42')).toEqual(['aaa', 'bbb']);
        expect(VotingLogic.livePinnedIds(build([A, B], { boost: { state: 'USED' } }), '42')).toEqual(['bbb']);
        expect(VotingLogic.livePinnedIds(build([A, B], { turbo: { state: 'USED' } }), '42')).toEqual(['aaa']);
        expect(VotingLogic.livePinnedIds(build([A, { id: 'zzz' }]), '42')).toEqual(['aaa']);
    });
});

describe('a pin for a feature that can never fire on the challenge protects nothing', () => {
    const entries = [A, B];
    const challengeOf = (type: string, maxPhotoSubmits: number) =>
        buildChallenge({
            id: '42',
            type,
            close_time: CLOSE,
            max_photo_submits: maxPhotoSubmits,
            member: { boost: { state: 'AVAILABLE_KEY' }, turbo: { state: 'WON' }, ranking: { entries } },
        });

    test.each([
        ['Boost on a flash challenge', 'flash', 3, { boost: 'aaa' }],
        ['Turbo on a flash challenge', 'flash', 3, { turbo: 'aaa' }],
        ['Boost on a single-photo challenge', 'open', 1, { boost: 'aaa' }],
        ['Turbo on an exhibition challenge', 'exhibition', 3, { turbo: 'aaa' }],
    ])('%s: no auto-swap protection', (_name, type, slots, pins) => {
        setup(pins);
        expect(VotingLogic.livePinnedIds(challengeOf(type, slots), '42')).toEqual([]);
    });

    test('a pin for the feature that does fire still protects', () => {
        setup({ boost: 'aaa' });
        expect(VotingLogic.livePinnedIds(challengeOf('exhibition', 3), '42')).toEqual(['aaa']);
    });
});

describe('resolveBoostFillNewMode', () => {
    test('a usable pin makes it no, over both fill-new modes', () => {
        setup({ boost: 'aaa' }, { boostNewSubmit: true, boostNewSubmitOnConflict: true });
        expect(VotingLogic.resolveBoostFillNewMode(build([A, B]), '42')).toBe('no');
    });

    test('an unusable pin leaves the fill-new modes as they were', () => {
        setup({ boost: 'zzz' }, { boostNewSubmit: true });
        expect(VotingLogic.resolveBoostFillNewMode(build([A]), '42')).toBe('always');
        setup({ boost: 'zzz' }, { boostNewSubmitOnConflict: true });
        expect(VotingLogic.resolveBoostFillNewMode(build([{ id: 'aaa', turbo: true }]), '42')).toBe('conflict');
    });
});

describe('resolveTurboFillNewMode', () => {
    test('a usable pin makes it no, over both fill-new modes', () => {
        setup({ turbo: 'aaa' }, { turboNewSubmit: true, turboNewSubmitOnConflict: true });
        expect(VotingLogic.resolveTurboFillNewMode(build([A, B]), '42')).toBe('no');
    });

    test('an unusable pin leaves the fill-new modes as they were', () => {
        setup({ turbo: 'zzz' }, { turboNewSubmit: true });
        expect(VotingLogic.resolveTurboFillNewMode(build([A]), '42')).toBe('always');
        setup({ turbo: 'zzz' }, { turboNewSubmitOnConflict: true });
        expect(VotingLogic.resolveTurboFillNewMode(build([{ id: 'aaa', boosted: true }]), '42')).toBe('conflict');
    });

    test('the on-conflict mode needs a conflict: a free entry, or no entries at all, is no', () => {
        setup({}, { turboNewSubmitOnConflict: true });
        expect(VotingLogic.resolveTurboFillNewMode(build([A]), '42')).toBe('no');
        expect(VotingLogic.resolveTurboFillNewMode(build([]), '42')).toBe('no');
    });
});

describe('shouldApplyTurbo with a pin', () => {
    test('a hit goes ahead of both fill-new modes, with the live id', () => {
        setup({ turbo: 'bbb' }, { turboNewSubmit: true, turboNewSubmitOnConflict: true });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), NOW)).toEqual({
            apply: true,
            imageId: 'bbb',
            fillNew: false,
            pinned: true,
            reason: 'eligible (pinned)',
        });
    });

    test('a phase overlay on turboImageIndex does not beat the pin', () => {
        setup({ turbo: 'aaa' }, { turboImageIndex: 2 });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), NOW).imageId).toBe('aaa');
    });

    test('a hit still waits for the turbo window and a won Turbo', () => {
        setup({ turbo: 'aaa' });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), CLOSE - 8000).apply).toBe(false);
        expect(VotingLogic.shouldApplyTurbo(build([A, B], { turbo: { state: 'FREE' } }), NOW).apply).toBe(false);
    });

    test('a gone or conflicting pin reports pinFallback on every apply path', () => {
        setup({ turbo: 'zzz' });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), NOW)).toMatchObject({
            apply: true,
            imageId: 'aaa',
            pinFallback: 'gone',
        });
        setup({ turbo: 'zzz' }, { turboNewSubmit: true });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), NOW)).toMatchObject({ fillNew: true, pinFallback: 'gone' });
        setup({ turbo: 'aaa' }, { turboNewSubmitOnConflict: true });
        expect(VotingLogic.shouldApplyTurbo(build([{ id: 'aaa', boosted: true }]), NOW)).toMatchObject({
            fillNew: true,
            imageId: null,
            pinFallback: 'conflict',
        });
    });

    test('no pin leaves the decision free of pin fields', () => {
        setup();
        const decision = VotingLogic.shouldApplyTurbo(build([A, B]), NOW);
        expect(decision).toEqual({ apply: true, imageId: 'aaa', fillNew: false, reason: 'eligible' });
    });
});

describe('pinFallbackOf and describePinFallback', () => {
    test('name why a pin did not decide the pick', () => {
        setup({ boost: 'zzz', turbo: 'aaa' });
        const challenge = build([{ id: 'aaa', boosted: true }, B]);
        expect(VotingLogic.pinFallbackOf(challenge, '42', 'boost')).toBe('gone');
        expect(VotingLogic.pinFallbackOf(challenge, '42', 'turbo')).toBe('conflict');
        setup({ boost: 'bbb' });
        expect(VotingLogic.pinFallbackOf(challenge, '42', 'boost')).toBeNull();
        setup();
        expect(VotingLogic.pinFallbackOf(challenge, '42', 'boost')).toBeNull();
    });

    test('word each fallback for the log', () => {
        expect(VotingLogic.describePinFallback('boost', 'gone')).toContain(
            "isn't in the challenge right now — using the usual boost settings",
        );
        expect(VotingLogic.describePinFallback('boost', 'conflict')).toContain('already has Turbo');
        expect(VotingLogic.describePinFallback('turbo', 'conflict')).toContain('already has Boost');
    });
});

describe('describeDeadlineActions reads the pinned pick', () => {
    const open = { state: 'AVAILABLE_KEY' };

    test('a usable pin keeps boostBlocked false', () => {
        setup({ boost: 'aaa' });
        expect(VotingLogic.describeDeadlineActions(build([A, B], { boost: open }), NOW).boostBlocked).toBe(false);
    });

    test('a conflicting pin falls back to the existing conflict row', () => {
        setup({ boost: 'aaa' });
        const challenge = build([{ id: 'aaa', turbo: true }], { boost: open });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(true);
    });

    test('a Turbo pin on the single entry blocks Boost, and a Boost pin on it blocks Turbo', () => {
        setup({ turbo: 'aaa' });
        const boostSide = build([A], { boost: open, turbo: { state: 'LOCKED' } });
        expect(VotingLogic.describeDeadlineActions(boostSide, NOW)).toMatchObject({
            boostBlocked: true,
            turboBlocked: false,
        });
        setup({ boost: 'aaa' });
        expect(VotingLogic.describeDeadlineActions(build([A], { boost: open }), NOW)).toMatchObject({
            boostBlocked: false,
            turboBlocked: true,
        });
    });

    test('a free slot with the on-conflict option resolves the block', () => {
        setup({ boost: 'aaa' }, { turboNewSubmitOnConflict: true });
        expect(VotingLogic.describeDeadlineActions(build([A], { boost: open }), NOW).turboBlocked).toBe(false);
    });

    test('a block that gives way inside Emergency Fill reports the release instant', () => {
        setup({ turbo: 'aaa' }, { emergencySubmit: 300 });
        const challenge = build([A], { boost: open, turbo: { state: 'LOCKED' } });
        const outside = VotingLogic.describeDeadlineActions(challenge, CLOSE - 1000);
        expect(outside).toMatchObject({
            boostBlocked: true,
            boostBlockedBy: 'pin',
            boostReleaseAt: CLOSE - 300,
            turboReleaseAt: null,
        });
        const inside = VotingLogic.describeDeadlineActions(challenge, CLOSE - 100);
        expect(inside).toMatchObject({ boostBlocked: false, boostBlockedBy: null, boostReleaseAt: null });
    });
});
