/**
 * orderDeadlineActions decides the order in which a challenge's deadline-gated
 * actions (auto-fill, turbo apply, emergency fill, boost) run within a cycle.
 * Order follows each action's seconds-before-close activation threshold, largest
 * window first, with a stable tie-break (autoFill → emergencyFill → boost →
 * turbo). Each action's own handler still decides whether to actually act.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

jest.mock('../../src/js/settings');

const mockSettings = (overrides = {}) => {
    const defaults = {
        autoFillIntervalMinutes: 10,
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
        // 1 free slot × 15m interval = 900s; turbo 720s; emergency 300s; no boost.
        mockSettings({ autoFillIntervalMinutes: 15, turboTime: 720, emergencyFill: 300 });
        expect(order(buildChallenge())).toEqual(['autoFill', 'turbo', 'emergencyFill', 'boost']);
    });

    test('honors the configured timers when turbo opens earlier than auto-fill', () => {
        // turbo 1200s > auto-fill 900s → turbo first.
        mockSettings({ autoFillIntervalMinutes: 15, turboTime: 1200, emergencyFill: 300 });
        expect(order(buildChallenge())).toEqual(['turbo', 'autoFill', 'emergencyFill', 'boost']);
    });

    test('tie-break: equal auto-fill and turbo thresholds put auto-fill first', () => {
        // 1 slot × 12m = 720s; turbo 720s → tie resolved to autoFill before turbo.
        mockSettings({ autoFillIntervalMinutes: 12, turboTime: 720, emergencyFill: 300 });
        const result = VotingLogic.orderDeadlineActions(buildChallenge());
        expect(result.map((a) => a.action)).toEqual(['autoFill', 'turbo', 'emergencyFill', 'boost']);
        expect(result[0].thresholdSec).toBe(720);
        expect(result[1].thresholdSec).toBe(720);
    });

    test('tie-break: equal emergency-fill and boost thresholds put emergency-fill first', () => {
        // key-unlocked boost = 900s; emergencyFill 900s → tie resolved emergencyFill before boost.
        mockSettings({ autoFillIntervalMinutes: 10, turboTime: 7200, emergencyFill: 900 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE_KEY' } });
        const result = VotingLogic.orderDeadlineActions(challenge).filter((a) => a.thresholdSec === 900);
        expect(result.map((a) => a.action)).toEqual(['emergencyFill', 'boost']);
    });

    test('key-unlocked boost sorts at its fixed 15m (900s) closing window', () => {
        // boost 900s > turbo 720s > auto-fill 600s (1 slot × 10m) > emergency 300s.
        mockSettings({ autoFillIntervalMinutes: 10, turboTime: 720, emergencyFill: 300 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE_KEY' } });
        expect(order(challenge)).toEqual(['boost', 'turbo', 'autoFill', 'emergencyFill']);
    });

    test('timer-based boost threshold = close_time − boost.timeout + boostTime', () => {
        // timeout 1000s before close, boostTime 3600 → 1000 + 3600 = 4600s, sorts first.
        mockSettings({ autoFillIntervalMinutes: 10, turboTime: 720, emergencyFill: 300, boostTime: 3600 });
        const challenge = buildChallenge({ boost: { state: 'AVAILABLE', timeout: 1_000_000 - 1000 } });
        const result = VotingLogic.orderDeadlineActions(challenge);
        expect(result[0].action).toBe('boost');
        expect(result[0].thresholdSec).toBe(4600);
    });

    test('no free slots: auto-fill threshold is 0 but still ranks above an absent boost', () => {
        // maxSubmits 1 with 1 entry → 0 slots → auto-fill 0s; no boost → -Infinity.
        mockSettings({ autoFillIntervalMinutes: 10, turboTime: 720, emergencyFill: 300 });
        const challenge = buildChallenge({ maxSubmits: 1, entries: [{ id: 'e1' }] });
        expect(order(challenge)).toEqual(['turbo', 'emergencyFill', 'autoFill', 'boost']);
    });

    test('emergency fill off (0) sorts to the bottom of the threshold band', () => {
        mockSettings({ autoFillIntervalMinutes: 10, turboTime: 720, emergencyFill: 0 });
        // auto-fill 600s, turbo 720s, emergency 0s, boost -Infinity.
        expect(order(buildChallenge())).toEqual(['turbo', 'autoFill', 'emergencyFill', 'boost']);
    });
});
