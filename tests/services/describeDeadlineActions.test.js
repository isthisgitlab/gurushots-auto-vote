/**
 * describeDeadlineActions is the read-only, renderer-facing view behind the
 * get-deadline-actions IPC channel: the deadline actions that will ACTUALLY
 * fire (gated on the runner's own conditions, not just a positive threshold)
 * plus each one's absolute dueAt, and the boost/turbo conflict flag.
 *
 * These tests pin the review's correctness fixes: no phantom turbo row when no
 * turbo is held, no phantom boost row when boostTime=0, off/n-a rows omitted,
 * and the boostBlocked empty-entry guard.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');
const { buildChallenge: buildBaseChallenge } = require('../helpers/challengeFixtures');

jest.mock('../../src/js/settings');

const NOW = 1_000_000 - 100; // just before close_time below
const CLOSE = 1_000_000;

const mockSettings = (overrides = {}) => {
    const defaults = {
        autoFillSchedule: [{ count: 2, seconds: 900 }],
        turboTime: 7200,
        emergencyFill: 300,
        boostTime: 3600,
        keyUnlockedBoostTime: 900,
        autoBoost: true,
        useTurbo: true,
        autoFill: true,
        boostImageIndex: 1,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
};

const build = ({
    boost = { state: 'NONE' },
    turbo = { state: 'NONE' },
    entries = [{ id: 'e1' }],
    maxSubmits = 2,
} = {}) =>
    buildBaseChallenge({
        id: '42',
        close_time: CLOSE,
        max_photo_submits: maxSubmits,
        member: { boost, turbo, ranking: { entries } },
    });

const actionsOf = (challenge, now = NOW) =>
    VotingLogic.describeDeadlineActions(challenge, now).actions.map((a) => a.action);

describe('describeDeadlineActions — row gating', () => {
    beforeEach(() => jest.clearAllMocks());

    test('no phantom turbo row when no turbo is held', () => {
        mockSettings();
        // turboTime is a positive default (7200) even with no turbo — must be omitted.
        expect(actionsOf(build({ turbo: { state: 'NONE' } }))).not.toContain('turbo');
    });

    test('turbo row shown when a turbo is WON and useTurbo is on', () => {
        mockSettings({ useTurbo: true });
        expect(actionsOf(build({ turbo: { state: 'WON' } }))).toContain('turbo');
    });

    test('turbo row hidden when a turbo is WON but useTurbo is off', () => {
        mockSettings({ useTurbo: false });
        expect(actionsOf(build({ turbo: { state: 'WON' } }))).not.toContain('turbo');
    });

    test('no phantom boost row when boostTime=0 on a timer boost', () => {
        mockSettings({ boostTime: 0 });
        // AVAILABLE with a future timeout → timer branch; boostTime 0 = off.
        const challenge = build({ boost: { state: 'AVAILABLE', timeout: CLOSE - 1000 } });
        expect(actionsOf(challenge)).not.toContain('boost');
    });

    test('boost row shown when boostTime>0 on a timer boost', () => {
        mockSettings({ boostTime: 3600 });
        const challenge = build({ boost: { state: 'AVAILABLE', timeout: CLOSE - 1000 } });
        expect(actionsOf(challenge)).toContain('boost');
    });

    test('boost row shown for an available key-unlocked boost with autoBoost on', () => {
        mockSettings({ autoBoost: true, keyUnlockedBoostTime: 900 });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1' }] });
        expect(actionsOf(challenge)).toContain('boost');
    });

    test('boost row hidden when autoBoost is off', () => {
        mockSettings({ autoBoost: false });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' } });
        expect(actionsOf(challenge)).not.toContain('boost');
    });

    test('boost row suppressed when the boost is blocked (sole entry already turboed)', () => {
        mockSettings({ autoBoost: true, keyUnlockedBoostTime: 900 });
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1', turbo: true }] });
        const result = VotingLogic.describeDeadlineActions(challenge, NOW);
        // The conflict owns this case — the timeline must not also show a boost row.
        expect(result.actions.map((a) => a.action)).not.toContain('boost');
        expect(result.boostBlocked).toBe(true);
    });

    test('autoFill row hidden when autoFill is off', () => {
        mockSettings({ autoFill: false });
        expect(actionsOf(build())).not.toContain('autoFill');
    });

    test('emergency-fill row omitted when off (0)', () => {
        mockSettings({ emergencyFill: 0 });
        expect(actionsOf(build())).not.toContain('emergencyFill');
    });

    test('dueAt = close_time − thresholdSec', () => {
        mockSettings({ autoFill: true, autoFillSchedule: [{ count: 2, seconds: 900 }] });
        const { actions } = VotingLogic.describeDeadlineActions(build(), NOW);
        const autoFill = actions.find((a) => a.action === 'autoFill');
        expect(autoFill.dueAt).toBe(CLOSE - autoFill.thresholdSec);
    });
});

describe('describeDeadlineActions — boostBlocked', () => {
    beforeEach(() => jest.clearAllMocks());

    test('false on a zero-entry challenge with an open boost window', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });

    test('true when the sole entry already has Turbo and boost is available', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1', turbo: true }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(true);
    });

    test('false when the boost window is closed', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'USED' }, entries: [{ id: 'e1', turbo: true }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });

    test('false when the sole entry is placeable (not turboed)', () => {
        mockSettings();
        const challenge = build({ boost: { state: 'AVAILABLE_KEY' }, entries: [{ id: 'e1' }] });
        expect(VotingLogic.describeDeadlineActions(challenge, NOW).boostBlocked).toBe(false);
    });
});
