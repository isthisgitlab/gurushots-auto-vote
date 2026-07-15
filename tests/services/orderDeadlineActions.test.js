/**
 * orderDeadlineActions decides the order in which a challenge's deadline-gated
 * actions (auto-fill, turbo apply, emergency fill, boost) run within a cycle.
 * Order follows each action's seconds-before-close activation threshold, largest
 * window first, with a stable tie-break (autoFill → emergencyFill → boost →
 * turbo). Each action's own handler still decides whether to actually act.
 *
 * The auto-fill threshold comes from the autoFillSchedule setting (rows of
 * { count, seconds }): the largest threshold among rows whose (clamped) count
 * exceeds the current entry count — see autoFill.getNextScheduleThresholdSec.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

jest.mock('../../src/js/settings');

// Mirrors the schema default: 2 @ 30m, 3 @ 20m, 4 @ 10m before close.
const DEFAULT_SCHEDULE = [
    { count: 2, seconds: 1800 },
    { count: 3, seconds: 1200 },
    { count: 4, seconds: 600 },
];

const mockSettings = (overrides = {}) => {
    const defaults = {
        autoFillSchedule: DEFAULT_SCHEDULE,
        turboTime: 7200,
        emergencyFill: 300,
        boostTime: 3600,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
};

const buildChallenge = ({
    closeTime = 1_000_000,
    maxSubmits = 2,
    entries = [{ id: 'e1' }], // 1 free slot by default (maxSubmits 2)
    boost = { state: 'NONE' },
} = {}) => ({
    id: '42',
    close_time: closeTime,
    max_photo_submits: maxSubmits,
    member: { boost, ranking: { entries } },
});

const order = (challenge) => VotingLogic.orderDeadlineActions(challenge).map((a) => a.action);

describe('orderDeadlineActions', () => {
    beforeEach(() => jest.clearAllMocks());

    test('user scenario: auto-fill (15m) runs before turbo (12m), then emergency, then boost', () => {
        // 1 entry of max 2; the next row due is {2 @ 900s}; turbo 720s; emergency 300s; no boost.
        mockSettings({ autoFillSchedule: [{ count: 2, seconds: 900 }], turboTime: 720, emergencyFill: 300 });
        expect(order(buildChallenge())).toEqual(['autoFill', 'turbo', 'emergencyFill', 'boost']);
    });

    test('honors the configured timers when turbo opens earlier than auto-fill', () => {
        // turbo 1200s > auto-fill 900s → turbo first.
        mockSettings({ autoFillSchedule: [{ count: 2, seconds: 900 }], turboTime: 1200, emergencyFill: 300 });
        expect(order(buildChallenge())).toEqual(['turbo', 'autoFill', 'emergencyFill', 'boost']);
    });

    test('tie-break: equal auto-fill and turbo thresholds put auto-fill first', () => {
        // Next schedule row at 720s; turbo 720s → tie resolved to autoFill before turbo.
        mockSettings({ autoFillSchedule: [{ count: 2, seconds: 720 }], turboTime: 720, emergencyFill: 300 });
        const result = VotingLogic.orderDeadlineActions(buildChallenge());
        expect(result.map((a) => a.action)).toEqual(['autoFill', 'turbo', 'emergencyFill', 'boost']);
        expect(result[0].thresholdSec).toBe(720);
        expect(result[1].thresholdSec).toBe(720);
    });

    test('tie-break: equal emergency-fill and boost thresholds put emergency-fill first', () => {
        // key-unlocked boost = 900s; emergencyFill 900s → tie resolved emergencyFill before boost.
        mockSettings({ turboTime: 7200, emergencyFill: 900 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE_KEY' } });
        const result = VotingLogic.orderDeadlineActions(challenge).filter((a) => a.thresholdSec === 900);
        expect(result.map((a) => a.action)).toEqual(['emergencyFill', 'boost']);
    });

    test('key-unlocked boost sorts at its fixed 15m (900s) closing window', () => {
        // boost 900s > turbo 720s > auto-fill 600s (next row {2 @ 600s}) > emergency 300s.
        mockSettings({ autoFillSchedule: [{ count: 2, seconds: 600 }], turboTime: 720, emergencyFill: 300 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE_KEY' } });
        expect(order(challenge)).toEqual(['boost', 'turbo', 'autoFill', 'emergencyFill']);
    });

    test('timer-based boost threshold = close_time − boost.timeout + boostTime', () => {
        // timeout 1000s before close, boostTime 3600 → 1000 + 3600 = 4600s, sorts first.
        mockSettings({ turboTime: 720, emergencyFill: 300, boostTime: 3600 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE', timeout: 1_000_000 - 1000 } });
        const result = VotingLogic.orderDeadlineActions(challenge);
        expect(result[0].action).toBe('boost');
        expect(result[0].thresholdSec).toBe(4600);
    });

    test('no free slots: auto-fill threshold is 0 but still ranks above an absent boost', () => {
        // maxSubmits 1 with 1 entry → every schedule row clamps to 1, none is
        // above the entry count → auto-fill 0s; no boost → -Infinity.
        mockSettings({ turboTime: 720, emergencyFill: 300 });
        const challenge = buildChallenge({ maxSubmits: 1, entries: [{ id: 'e1' }] });
        expect(order(challenge)).toEqual(['turbo', 'emergencyFill', 'autoFill', 'boost']);
    });

    test('schedule satisfied for the current entry count: only later rows set the threshold', () => {
        // 2 of 4 entries: rows {3 @ 1200} and {4 @ 600} are still unmet → 1200s.
        mockSettings({ turboTime: 720, emergencyFill: 300 });
        const challenge = buildChallenge({ maxSubmits: 4, entries: [{ id: 'e1' }, { id: 'e2' }] });
        const result = VotingLogic.orderDeadlineActions(challenge);
        expect(result[0]).toEqual({ action: 'autoFill', thresholdSec: 1200 });
    });

    test('emergency fill off (0) sorts to the bottom of the threshold band', () => {
        mockSettings({ autoFillSchedule: [{ count: 2, seconds: 600 }], turboTime: 720, emergencyFill: 0 });
        // auto-fill 600s, turbo 720s, emergency 0s, boost -Infinity.
        expect(order(buildChallenge())).toEqual(['turbo', 'autoFill', 'emergencyFill', 'boost']);
    });

    describe('malformed autoFillSchedule flows through without throwing', () => {
        test.each([
            ['a string', 'garbage'],
            ['rows without count/seconds', [{ bad: true }]],
            ['null', null],
        ])('%s → finite autoFill thresholdSec of 0', (_label, schedule) => {
            mockSettings({ autoFillSchedule: schedule, turboTime: 720, emergencyFill: 300 });
            let result;
            expect(() => {
                result = VotingLogic.orderDeadlineActions(buildChallenge());
            }).not.toThrow();
            const autoFill = result.find((a) => a.action === 'autoFill');
            expect(autoFill.thresholdSec).toBe(0);
            expect(Number.isFinite(autoFill.thresholdSec)).toBe(true);
            // The 0 threshold sorts below the real windows, above the absent boost.
            expect(result.map((a) => a.action)).toEqual(['turbo', 'emergencyFill', 'autoFill', 'boost']);
        });
    });
});
