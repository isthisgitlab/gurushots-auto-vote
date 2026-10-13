/**
 * The photo pinned for Boost or Turbo on the decision layer: how a pin resolves
 * against the live entries, what it beats, how each feature's slot pick steers
 * clear of the other feature's live pin without ever stranding a spend, and the
 * deadline preview that reads the same pick.
 */

jest.mock('../../src/ts/settings');

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as VotingLogicModule from '../../src/ts/services/VotingLogic';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { Challenge, RankingEntry } from '../../src/ts/types/gurushots';
import type { EntryPins } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';
const VotingLogic = require('../../src/ts/services/VotingLogic') as typeof VotingLogicModule;
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
        autoFill: false,
        emergencyFill: 0,
        autoFillSchedule: [],
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
            expect(VotingLogic.pickBoostEntry(build(order), '42')?.id).toBe('ccc');
        }
    });

    test('a pin beats boostImageIndex', () => {
        setup({ boost: 'bbb' }, { boostImageIndex: 3 });
        expect(VotingLogic.pickBoostEntry(build([A, B, C]), '42')?.id).toBe('bbb');
    });

    test('a gone pin falls back to the slot pick', () => {
        setup({ boost: 'zzz' }, { boostImageIndex: 2 });
        expect(VotingLogic.pickBoostEntry(build([A, B, C]), '42')?.id).toBe('bbb');
    });

    test('a conflicting pin falls back to the slot pick', () => {
        setup({ boost: 'aaa' }, { boostImageIndex: 1 });
        const entries = [{ id: 'aaa', turbo: true }, B];
        expect(VotingLogic.pickBoostEntry(build(entries), '42')?.id).toBe('bbb');
    });

    test('no entries is still null', () => {
        setup({ boost: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([]), '42')).toBeNull();
    });

    test('null still means every candidate carries Turbo', () => {
        setup({ turbo: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([{ id: 'aaa', turbo: true }]), '42')).toBeNull();
    });
});

describe('the slot pick avoids the other feature’s live pin', () => {
    test('Turbo steers off the photo pinned for Boost (default turboImageIndex=1)', () => {
        setup({ boost: 'aaa' });
        const decision = VotingLogic.shouldApplyTurbo(build([A, B]), NOW);
        expect(decision).toMatchObject({ apply: true, imageId: 'bbb', fillNew: false });
    });

    test('Boost steers off the photo pinned for Turbo (default boostImageIndex=1)', () => {
        setup({ turbo: 'aaa' });
        expect(VotingLogic.pickBoostEntry(build([A, B]), '42')?.id).toBe('bbb');
    });

    test('pickEntryAvoidingConflict walks past the flagged entry and the avoided photo', () => {
        const entries = [A, B, { id: 'ccc', boosted: true }];
        expect(VotingLogic.pickEntryAvoidingConflict(entries, 1, 'boosted', 'aaa')?.id).toBe('bbb');
        expect(VotingLogic.pickEntryAvoidingConflict(entries, 1, 'boosted')?.id).toBe('aaa');
    });

    test('an avoided photo that leaves no candidate is dropped from the preference', () => {
        expect(VotingLogic.pickEntryAvoidingConflict([A], 1, 'boosted', 'aaa')?.id).toBe('aaa');
        expect(VotingLogic.pickEntryAvoidingConflict([A, { id: 'bbb', boosted: true }], 1, 'boosted', 'aaa')?.id).toBe(
            'aaa',
        );
    });

    test('null still means every candidate carries the flag, avoided photo or not', () => {
        expect(VotingLogic.pickEntryAvoidingConflict([{ id: 'aaa', boosted: true }], 1, 'boosted', 'aaa')).toBeNull();
    });

    test('the fill-new fallback target steers off the Boost pin too', () => {
        setup({ boost: 'aaa' }, { turboFillNew: true });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), NOW)).toMatchObject({
            apply: true,
            fillNew: true,
            imageId: 'bbb',
        });
    });
});

describe('a pin never strands a spend', () => {
    test('two entries, Boost pinned on A and spent on B: Turbo still lands on A', () => {
        setup({ boost: 'aaa' });
        const challenge = build([A, { id: 'bbb', boosted: true }], { boost: { state: 'USED' } });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW)).toMatchObject({ apply: true, imageId: 'aaa' });
    });

    test('two entries, Turbo pinned on A and applied to B: Boost still lands on A', () => {
        setup({ turbo: 'aaa' });
        const challenge = build([A, { id: 'bbb', turbo: true }], { turbo: { state: 'USED' } });
        expect(VotingLogic.pickBoostEntry(challenge, '42')?.id).toBe('aaa');
    });

    test('one entry with a Turbo pin and Turbo never won: Boost still lands on it', () => {
        setup({ turbo: 'aaa' });
        const challenge = build([A], { turbo: { state: 'LOCKED' } });
        expect(VotingLogic.pickBoostEntry(challenge, '42')?.id).toBe('aaa');
    });

    test('one entry with a Boost pin: Turbo still lands on it', () => {
        setup({ boost: 'aaa' });
        expect(VotingLogic.shouldApplyTurbo(build([A]), NOW)).toMatchObject({ apply: true, imageId: 'aaa' });
    });

    test('the only entry already carrying the other flag is still a noop with its existing reason', () => {
        setup({ boost: 'aaa' });
        const challenge = build([{ id: 'aaa', boosted: true }]);
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW)).toMatchObject({
            apply: false,
            reason: 'only entry already has Boost applied',
        });
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
        expect(VotingLogic.pickBoostEntry(build(entries, states), '42')?.id).toBe('aaa');
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
        setup({ boost: 'aaa' }, { boostFillNew: true, boostFillNewOnConflict: true });
        expect(VotingLogic.resolveBoostFillNewMode(build([A, B]), '42')).toBe('no');
    });

    test('an unusable pin leaves the fill-new modes as they were', () => {
        setup({ boost: 'zzz' }, { boostFillNew: true });
        expect(VotingLogic.resolveBoostFillNewMode(build([A]), '42')).toBe('always');
        setup({ boost: 'zzz' }, { boostFillNewOnConflict: true });
        expect(VotingLogic.resolveBoostFillNewMode(build([{ id: 'aaa', turbo: true }]), '42')).toBe('conflict');
    });
});

describe('shouldApplyTurbo with a pin', () => {
    test('a hit goes ahead of both fill-new modes, with the live id', () => {
        setup({ turbo: 'bbb' }, { turboFillNew: true, turboFillNewOnConflict: true });
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
        setup({ turbo: 'zzz' }, { turboFillNew: true });
        expect(VotingLogic.shouldApplyTurbo(build([A, B]), NOW)).toMatchObject({ fillNew: true, pinFallback: 'gone' });
        setup({ turbo: 'aaa' }, { turboFillNewOnConflict: true });
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

    test('a Turbo pin on the single entry does not block Boost', () => {
        setup({ turbo: 'aaa' });
        const challenge = build([A], { boost: open, turbo: { state: 'LOCKED' } });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });
});
