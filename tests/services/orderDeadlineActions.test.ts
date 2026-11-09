/**
 * orderDeadlineActions decides the order in which a challenge's deadline-gated
 * actions (auto-fill, turbo apply, emergency fill, boost) run within a cycle.
 * Order follows each action's seconds-before-close activation threshold, largest
 * window first, with a stable tie-break (autoSubmit → emergencySubmit → boost →
 * turbo). Each action's own handler still decides whether to actually act.
 *
 * The auto-fill threshold comes from the autoSubmitSchedule setting (rows of
 * { count, seconds }): the largest threshold among rows whose count exceeds
 * the current entry count, after the schedule end-aligns to the challenge's
 * photo limit (a 2-image challenge follows the Image-4 row's time for its
 * final photo) — see autoFill.getNextScheduleThresholdSec / scheduleRemap.ts.
 */

import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);
import VotingLogic = require('../../src/ts/core/services/VotingLogic');
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import { invalid } from '../helpers/invalid';
const { buildChallenge: buildBaseChallenge } =
    require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

jest.mock('../../src/ts/core/settings');

// Mirrors the schema default: 2 @ 30m, 3 @ 20m, 4 @ 10m before close.
const DEFAULT_SCHEDULE = [
    { count: 2, seconds: 1800 },
    { count: 3, seconds: 1200 },
    { count: 4, seconds: 600 },
];

const mockSettings = (overrides: Record<string, unknown> = {}) => {
    const defaults: Record<string, unknown> = {
        autoSubmitSchedule: DEFAULT_SCHEDULE,
        turboTime: 7200,
        emergencySubmit: 300,
        boostTime: 3600,
        keyUnlockedBoostTime: 900,
    };
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => ({ ...defaults, ...overrides })[key]));
    settings.getSetting = invalid(jest.fn((key: string) => (key === 'timezone' ? 'UTC' : null)));
};

const buildChallenge = ({
    closeTime = 1_000_000,
    maxSubmits = 2,
    entries = [{ id: 'e1' }], // 1 free slot by default (maxSubmits 2)
    boost = { state: 'NONE' },
}: {
    closeTime?: number;
    maxSubmits?: number;
    entries?: Array<{ id: string }>;
    boost?: { state: string; timeout?: number };
} = {}) =>
    buildBaseChallenge({
        id: '42',
        close_time: closeTime,
        max_photo_submits: maxSubmits,
        member: { boost, ranking: { entries } },
    });

const order = (challenge: Challenge) => VotingLogic.orderDeadlineActions(challenge, 0).map((a) => a.action);

describe('orderDeadlineActions', () => {
    beforeEach(() => jest.clearAllMocks());

    test('user scenario: auto-fill (15m) runs before turbo (12m), then emergency, then boost', () => {
        // 1 entry of max 2; the next row due is {2 @ 900s}; turbo 720s; emergency 300s; no boost.
        mockSettings({ autoSubmitSchedule: [{ count: 2, seconds: 900 }], turboTime: 720, emergencySubmit: 300 });
        expect(order(buildChallenge())).toEqual(['autoSubmit', 'turbo', 'emergencySubmit', 'boost']);
    });

    test('honors the configured timers when turbo opens earlier than auto-fill', () => {
        // turbo 1200s > auto-fill 900s → turbo first.
        mockSettings({ autoSubmitSchedule: [{ count: 2, seconds: 900 }], turboTime: 1200, emergencySubmit: 300 });
        expect(order(buildChallenge())).toEqual(['turbo', 'autoSubmit', 'emergencySubmit', 'boost']);
    });

    test('tie-break: equal auto-fill and turbo thresholds put auto-fill first', () => {
        // Next schedule row at 720s; turbo 720s → tie resolved to autoSubmit before turbo.
        mockSettings({ autoSubmitSchedule: [{ count: 2, seconds: 720 }], turboTime: 720, emergencySubmit: 300 });
        const result = VotingLogic.orderDeadlineActions(buildChallenge(), 0);
        expect(result.map((a) => a.action)).toEqual(['autoSubmit', 'turbo', 'emergencySubmit', 'boost']);
        expect(result[0].thresholdSec).toBe(720);
        expect(result[1].thresholdSec).toBe(720);
    });

    test('tie-break: equal emergency-fill and boost thresholds put emergency-fill first', () => {
        // key-unlocked boost = 900s; emergencySubmit 900s → tie resolved emergencySubmit before boost.
        mockSettings({ turboTime: 7200, emergencySubmit: 900 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE_KEY' } });
        const result = VotingLogic.orderDeadlineActions(challenge, 0).filter((a) => a.thresholdSec === 900);
        expect(result.map((a) => a.action)).toEqual(['emergencySubmit', 'boost']);
    });

    test('key-unlocked boost sorts at its fixed 15m (900s) closing window', () => {
        // boost 900s > turbo 720s > auto-fill 600s (next row {2 @ 600s}) > emergency 300s.
        mockSettings({ autoSubmitSchedule: [{ count: 2, seconds: 600 }], turboTime: 720, emergencySubmit: 300 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE_KEY' } });
        expect(order(challenge)).toEqual(['boost', 'turbo', 'autoSubmit', 'emergencySubmit']);
    });

    test('timer-based boost threshold = close_time − boost.timeout + boostTime', () => {
        // timeout 1000s before close, boostTime 3600 → 1000 + 3600 = 4600s, sorts first.
        mockSettings({ turboTime: 720, emergencySubmit: 300, boostTime: 3600 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE', timeout: 1_000_000 - 1000 } });
        const result = VotingLogic.orderDeadlineActions(challenge, 0);
        expect(result[0].action).toBe('boost');
        expect(result[0].thresholdSec).toBe(4600);
    });

    test('no free slots: auto-fill threshold is 0 but still ranks above an absent boost', () => {
        // maxSubmits 1 with 1 entry → the end-aligned schedule shifts every row
        // below count 2 (entry 1 always exists), none is above the entry
        // count → auto-fill 0s; no boost → -Infinity.
        mockSettings({ turboTime: 720, emergencySubmit: 300 });
        const challenge = buildChallenge({ maxSubmits: 1, entries: [{ id: 'e1' }] });
        expect(order(challenge)).toEqual(['turbo', 'emergencySubmit', 'autoSubmit', 'boost']);
    });

    test('schedule satisfied for the current entry count: only later rows set the threshold', () => {
        // 2 of 4 entries: rows {3 @ 1200} and {4 @ 600} are still unmet → 1200s.
        mockSettings({ turboTime: 720, emergencySubmit: 300 });
        const challenge = buildChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }] });
        const result = VotingLogic.orderDeadlineActions(challenge, 0);
        expect(result[0]).toEqual({ action: 'autoSubmit', thresholdSec: 1200 });
    });

    test('2-image challenge end-aligns the default schedule: fill due at 600s, not 1800s', () => {
        // Through the real wiring (getAutoFillThresholdSec →
        // orderDeadlineActions): 1 entry of max 2 with the full default schedule
        // must not open the fill window at the Image-2 row (1800s). End-aligned,
        // the 2nd (final) photo follows the Image-4 row → 600s, so turbo (720s)
        // sorts first.
        mockSettings({ turboTime: 720, emergencySubmit: 300 });
        const result = VotingLogic.orderDeadlineActions(buildChallenge(), 0);
        const autoSubmit = result.find((a) => a.action === 'autoSubmit');
        expect(autoSubmit!.thresholdSec).toBe(600);
        expect(result.map((a) => a.action)).toEqual(['turbo', 'autoSubmit', 'emergencySubmit', 'boost']);
    });

    test('emergency fill off (0) sorts to the bottom of the threshold band', () => {
        mockSettings({ autoSubmitSchedule: [{ count: 2, seconds: 600 }], turboTime: 720, emergencySubmit: 0 });
        // auto-fill 600s, turbo 720s, emergency 0s, boost -Infinity.
        expect(order(buildChallenge())).toEqual(['turbo', 'autoSubmit', 'emergencySubmit', 'boost']);
    });

    test('an empty autoSubmitSchedule gives autoSubmit a threshold of 0', () => {
        mockSettings({ autoSubmitSchedule: [], turboTime: 720, emergencySubmit: 300 });
        const result = VotingLogic.orderDeadlineActions(buildChallenge(), 0);
        expect(result.find((a) => a.action === 'autoSubmit')!.thresholdSec).toBe(0);
        // The 0 threshold sorts below the real windows, above the absent boost.
        expect(result.map((a) => a.action)).toEqual(['turbo', 'emergencySubmit', 'autoSubmit', 'boost']);
    });

    test('an active clock submission runs first while Turbo, Boost, and Emergency keep their thresholds and order', () => {
        const now = Date.UTC(2026, 0, 15, 12, 30) / 1000;
        mockSettings({
            autoSubmit: true,
            autoSubmitTime: ['12:00'],
            autoSubmitWindowMinutes: 60,
            autoSubmitSchedule: [{ count: 2, seconds: 600 }],
            turboTime: 7200,
            emergencySubmit: 300,
        });
        const actions = VotingLogic.orderDeadlineActions(
            buildChallenge({ closeTime: now + 10_000, boost: { state: 'AVAILABLE_KEY' } }),
            now,
        );
        expect(actions).toEqual([
            { action: 'autoSubmit', thresholdSec: 600 },
            { action: 'turbo', thresholdSec: 7200 },
            { action: 'boost', thresholdSec: 900 },
            { action: 'emergencySubmit', thresholdSec: 300 },
        ]);
    });
});
