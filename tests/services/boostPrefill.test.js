/**
 * Pre-boost exposure fill in VotingLogic.
 *
 * A Boost multiplies whatever the entry has at the instant it lands, and there
 * is one per challenge, so spending it on a decayed entry wastes it. When
 * `voteBeforeBoost` is on, the configured lead before the boost is auto-applied
 * becomes a vote-to-100% window.
 *
 * Two things carry the weight here and are asserted from both sides:
 *
 *   - the WINDOW is anchored to the same apply instant the boost runner uses
 *     (shared boostApplyThreshold), including the `0 = off` sentinel on both
 *     boost-time settings — a fill ahead of a boost that never fires is waste;
 *   - PRECEDENCE: it beats the voting pause, scheduled fill and every threshold
 *     rule, but never flash/last-minute (which already vote to 100% anyway) and
 *     never onlyBoost.
 *
 * Structure mirrors votingPause.test.js.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');
const { buildChallenge: buildBaseChallenge } = require('../helpers/challengeFixtures');

jest.mock('../../src/js/settings');

const NOW = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
const ID = '555';

/**
 * With the defaults below (boostTime 3600, close 2h out) the apply instant in
 * seconds-before-close is `7200 - boostExpiresInSec + 3600`, so:
 *   boostExpiresInSec 4200 → applies with 6600s left = 10 min from now (IN the
 *                            15 min lead window)
 *   boostExpiresInSec 6000 → applies with 4800s left = 40 min from now (window
 *                            opens 25 min from now — still ahead)
 */
const buildChallenge = ({
    exposureFactor = 50,
    closeInSeconds = 7200,
    type = 'regular',
    boostState = 'AVAILABLE',
    boostExpiresInSec = 4200,
} = {}) =>
    buildBaseChallenge({
        id: ID,
        title: 'Boost Prefill Challenge',
        type,
        close_time: NOW + closeInSeconds,
        start_time: NOW - 3600,
        member: {
            boost: { state: boostState, timeout: boostExpiresInSec === null ? 0 : NOW + boostExpiresInSec },
            ranking: { exposure: { exposure_factor: exposureFactor } },
        },
    });

const mockSettings = (overrides = {}) => {
    const defaults = {
        onlyBoost: false,
        voteOnlyInLastMinute: false,
        exposure: 100,
        lastMinuteThreshold: 10,
        finalWindowExposure: 40,
        useFinalWindowExposure: false,
        exposureTarget: 0,
        finalWindowExposureTarget: 0,
        voteBeforeFinalWindow: false,
        voteBeforeFinalWindowLeadMin: 15,
        finalWindowDuration: 3600,
        useScheduledFill: false,
        scheduledFillTime: [],
        scheduledFillBeforeEnd: [],
        scheduledFillWindowMinutes: 60,
        scheduledFillReplaces: false,
        useVotingPause: false,
        votingPauseTime: [],
        votingPauseBeforeEnd: [],
        votingPauseDurationMinutes: 240,
        // Boost prefill
        voteBeforeBoost: true,
        voteBeforeBoostLeadMin: 15,
        autoBoost: true,
        boostTime: 3600,
        keyUnlockedBoostTime: 900,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
    settings.getSetting = jest.fn((key) => (key === 'timezone' ? 'UTC' : undefined));
};

beforeEach(() => jest.clearAllMocks());

describe('getBoostPrefillState — gating', () => {
    test('inactive when the opt-in is off, even inside what would be the window', () => {
        mockSettings({ voteBeforeBoost: false });
        expect(VotingLogic.getBoostPrefillState(buildChallenge(), ID, NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('inactive when autoBoost is off — no boost fires, so there is nothing to fill ahead of', () => {
        mockSettings({ autoBoost: false });
        expect(VotingLogic.getBoostPrefillState(buildChallenge(), ID, NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('inactive when no boost is available to apply', () => {
        mockSettings();
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostState: 'NONE' }), ID, NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('inactive when boostTime is 0 — the off sentinel, which the raw threshold does NOT encode', () => {
        // Regression guard: getBoostThresholdSec's timer branch stays positive at
        // boostTime=0, so anchoring on it without re-checking the sentinel would
        // fill ahead of a boost that never fires.
        mockSettings({ boostTime: 0 });
        expect(VotingLogic.getBoostPrefillState(buildChallenge(), ID, NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('inactive when keyUnlockedBoostTime is 0 on the key-unlocked branch', () => {
        mockSettings({ keyUnlockedBoostTime: 0 });
        const challenge = buildChallenge({ boostState: 'AVAILABLE_KEY', closeInSeconds: 1500 });
        expect(VotingLogic.getBoostPrefillState(challenge, ID, NOW)).toEqual({ active: false, inWindow: false });
    });

    test('inactive when close_time is unusable', () => {
        mockSettings();
        const challenge = buildChallenge();
        challenge.close_time = null;
        expect(VotingLogic.getBoostPrefillState(challenge, ID, NOW)).toEqual({ active: false, inWindow: false });
    });
});

describe('getBoostPrefillState — window boundaries', () => {
    test('in window 10 minutes before a timer boost applies (15m lead)', () => {
        mockSettings();
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 4200 }), ID, NOW)).toEqual({
            active: true,
            inWindow: true,
        });
    });

    test('active but NOT in window while the boost is still 40 minutes out', () => {
        mockSettings();
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 6000 }), ID, NOW)).toEqual({
            active: true,
            inWindow: false,
        });
    });

    test('not in window once the apply instant has arrived — the boost fires this cycle', () => {
        // boostExpiresInSec 1800 <= boostTime 3600, i.e. shouldApplyBoost is already true.
        mockSettings();
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 1800 }), ID, NOW)).toEqual({
            active: true,
            inWindow: false,
        });
    });

    test('a wider lead pulls the same 40-minutes-out boost into the window', () => {
        mockSettings({ voteBeforeBoostLeadMin: 45 });
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 6000 }), ID, NOW)).toEqual({
            active: true,
            inWindow: true,
        });
    });

    test('key-unlocked boost is measured against close time, not a boost timer', () => {
        mockSettings();
        // Applies with 900s left; window is (900, 1800]. 1500s left → inside.
        const inside = buildChallenge({ boostState: 'AVAILABLE_KEY', closeInSeconds: 1500 });
        expect(VotingLogic.getBoostPrefillState(inside, ID, NOW)).toEqual({ active: true, inWindow: true });
        // 3600s left → still ahead of the window.
        const outside = buildChallenge({ boostState: 'AVAILABLE_KEY', closeInSeconds: 3600 });
        expect(VotingLogic.getBoostPrefillState(outside, ID, NOW)).toEqual({ active: true, inWindow: false });
    });

    test('AVAILABLE with no timeout is treated as key-unlocked, mirroring shouldApplyBoost', () => {
        mockSettings();
        const challenge = buildChallenge({ boostState: 'AVAILABLE', boostExpiresInSec: null, closeInSeconds: 1500 });
        expect(VotingLogic.getBoostPrefillState(challenge, ID, NOW)).toEqual({ active: true, inWindow: true });
    });

    test('a numeric-string lead is coerced, matching what the cadence resolvers send', () => {
        // Guard parity: both resolvers hand thresholdWindow.js `Number(raw) * 60`, so
        // reading the raw value here would clamp a hand-edited "45" to the 15m default
        // on the rule side while the scheduler capped on 45m.
        mockSettings({ voteBeforeBoostLeadMin: '45' });
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 6000 }), ID, NOW)).toEqual({
            active: true,
            inWindow: true,
        });
    });

    test('a corrupt lead falls back to the 15m schema default rather than disabling the window', () => {
        mockSettings({ voteBeforeBoostLeadMin: 'nonsense' });
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 4200 }), ID, NOW)).toEqual({
            active: true,
            inWindow: true,
        });
    });

    test('malformed data where the boost outlives the challenge never opens a window', () => {
        mockSettings({ boostTime: 60 });
        // timeout after close → apply instant lands at a negative seconds-before-close,
        // i.e. no usable anchor at all, so the feature reports itself inactive here
        // rather than armed-but-waiting for a moment that can never arrive.
        const challenge = buildChallenge({ closeInSeconds: 3600, boostExpiresInSec: 7200 });
        expect(VotingLogic.getBoostPrefillState(challenge, ID, NOW)).toEqual({ active: false, inWindow: false });
    });
});

describe('getBoostPrefillState — exact boundary instants', () => {
    // The strictly-before comparison is the load-bearing bit of this feature's
    // arithmetic: inWindow is (thresholdSec, thresholdSec + leadSec]. These pin both
    // ends exactly, so an off-by-one on either comparison fails here rather than in
    // production. Geometry: boostTime 3600, close 7200s out, lead 900s →
    // thresholdSec = 10800 - boostExpiresInSec.
    test('EXCLUSIVE at the apply instant itself (timeUntilEnd === thresholdSec)', () => {
        mockSettings();
        // thresholdSec = 7200 → boostExpiresInSec 3600.
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 3600 }), ID, NOW)).toEqual({
            active: true,
            inWindow: false,
        });
    });

    test('INCLUSIVE one second after the apply instant', () => {
        mockSettings();
        // thresholdSec = 7199 → boostExpiresInSec 3601.
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 3601 }), ID, NOW)).toEqual({
            active: true,
            inWindow: true,
        });
    });

    test('INCLUSIVE at the window opening edge (timeUntilEnd === thresholdSec + leadSec)', () => {
        mockSettings();
        // thresholdSec = 7200 - 900 = 6300 → boostExpiresInSec 4500.
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 4500 }), ID, NOW)).toEqual({
            active: true,
            inWindow: true,
        });
    });

    test('EXCLUSIVE one second before the window opens', () => {
        mockSettings();
        // thresholdSec = 6299 → boostExpiresInSec 4501, so the window closes at
        // 7199s remaining while 7200s remain: one second too early.
        expect(VotingLogic.getBoostPrefillState(buildChallenge({ boostExpiresInSec: 4501 }), ID, NOW)).toEqual({
            active: true,
            inWindow: false,
        });
    });
});

describe('getBoostPrefillState — defensive reads', () => {
    test('a challenge with no member node at all is inactive, not a throw', () => {
        mockSettings();
        const challenge = buildChallenge();
        delete challenge.member;
        expect(() => VotingLogic.getBoostPrefillState(challenge, ID, NOW)).not.toThrow();
        expect(VotingLogic.getBoostPrefillState(challenge, ID, NOW)).toEqual({ active: false, inWindow: false });
    });

    test('a throwing settings read degrades to inactive instead of aborting the challenge', () => {
        mockSettings();
        settings.getEffectiveSetting = jest.fn(() => {
            throw new Error('corrupt settings');
        });
        expect(VotingLogic.getBoostPrefillState(buildChallenge(), ID, NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });
});

describe('pre-boost rule precedence', () => {
    const decide = (challenge) => VotingLogic.evaluateVotingDecision(challenge, NOW);

    test('votes to 100% inside the window even though the normal threshold is satisfied', () => {
        // exposure 95 >= the normal trigger of 100? No — use a low trigger so the
        // normal rule would NOT vote, proving the pre-boost rule is what fired.
        mockSettings({ exposure: 50 });
        const result = decide(buildChallenge({ exposureFactor: 80 }));
        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toContain('pre-boost fill');
    });

    test('reports at-target without voting once exposure reaches 100%', () => {
        mockSettings();
        const result = decide(buildChallenge({ exposureFactor: 100 }));
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toBe('pre-boost fill: exposure already at 100%');
    });

    test('beats the voting pause — the boost is spent on the challenge schedule regardless', () => {
        mockSettings({ exposure: 50, useVotingPause: true, votingPauseTime: ['11:30'] });
        const result = decide(buildChallenge({ exposureFactor: 80 }));
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-boost fill');
    });

    test('beats a scheduled-fill replace block', () => {
        mockSettings({
            exposure: 50,
            useScheduledFill: true,
            scheduledFillTime: ['03:00'],
            scheduledFillReplaces: true,
        });
        const result = decide(buildChallenge({ exposureFactor: 80 }));
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-boost fill');
    });

    test('beats the final-window rule, whose lower target would leave the entry short', () => {
        mockSettings({
            exposure: 50,
            useFinalWindowExposure: true,
            finalWindowExposure: 40,
            keyUnlockedBoostTime: 900,
        });
        // 1500s to close → inside a 3600s final window AND inside the key-unlocked
        // prefill window; exposure 80 is above the final-window trigger of 40.
        const challenge = buildChallenge({ boostState: 'AVAILABLE_KEY', closeInSeconds: 1500, exposureFactor: 80 });
        const result = decide(challenge);
        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toContain('pre-boost fill');
    });

    test('onlyBoost still wins — it is the explicit "never spend votes" opt-out', () => {
        mockSettings({ onlyBoost: true });
        const result = decide(buildChallenge({ exposureFactor: 10 }));
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toBe('boost-only mode enabled');
    });

    test('last-minute still wins, keeping its own label', () => {
        mockSettings({ lastMinuteThreshold: 30 });
        // 1500s to close is inside a 30m last-minute threshold and inside the
        // key-unlocked prefill window; last-minute is checked first.
        const challenge = buildChallenge({ boostState: 'AVAILABLE_KEY', closeInSeconds: 1500, exposureFactor: 10 });
        expect(decide(challenge).voteReason).toContain('lastminute threshold');
    });

    test('a closed challenge is still skipped', () => {
        mockSettings();
        const challenge = buildChallenge();
        challenge.close_time = NOW - 1;
        expect(decide(challenge).voteReason).toBe('challenge has ended');
    });

    test('manual voting never takes the pre-boost path', () => {
        mockSettings({ exposure: 50 });
        const result = VotingLogic.evaluateManualVotingDecision(buildChallenge({ exposureFactor: 80 }), NOW, 'T');
        // Manual falls through to the normal threshold, where 80 >= 50 is at target —
        // the pre-boost branch is auto-only and must not colour the manual message.
        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toBe('Challenge "T" already has 50% exposure');
        expect(result.errorMessage).not.toContain('boost');
    });
});

describe('deliberate non-gating on the boost/turbo conflict', () => {
    test('still fills when the only entry already carries turbo', () => {
        // Intentional omission (see getBoostPrefillState's doc comment): that check
        // needs live entry state and only suppresses the BOOST, while the exposure
        // bought here counts either way. Locked in so a future "helpful" edit that
        // starts gating on it fails loudly.
        mockSettings({ exposure: 50 });
        const challenge = buildChallenge({ exposureFactor: 80 });
        challenge.member.ranking.entries = [{ id: 'e1', turbo: true, boosted: false }];
        const result = VotingLogic.evaluateVotingDecision(challenge, NOW);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-boost fill');
    });
});

describe('new-entry detection respects a completed pre-boost fill', () => {
    test('full exposure does not start another pre-boost vote', () => {
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 100 }), NOW, {
            hasNewEntry: true,
        });
        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('pre-boost fill: exposure already at 100%');
    });
});
