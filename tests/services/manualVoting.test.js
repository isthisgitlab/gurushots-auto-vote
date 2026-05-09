/**
 * Covers the manual-vote-to-100% evaluator that both the CLI
 * (BaseMiddleware.cliVoteManual) and the IPC handler
 * (vote-all-challenges-manual) route through. The evaluator is
 * deliberately simpler than the auto-vote one — it ignores all
 * threshold settings and only checks lifecycle (started, not ended)
 * and exposure ceiling (< 100%).
 */

const VotingLogic = require('../../src/js/services/VotingLogic');

jest.mock('../../src/js/settings');

const buildChallenge = ({ exposureFactor, startInSeconds = -3600, closeInSeconds = 7200 }) => {
    const now = Math.floor(Date.now() / 1000);
    return {
        id: '111',
        title: 'Manual Vote Challenge',
        type: 'regular',
        start_time: now + startInSeconds,
        close_time: now + closeInSeconds,
        member: { ranking: { exposure: { exposure_factor: exposureFactor } } },
    };
};

const NOW = () => Math.floor(Date.now() / 1000);

describe('evaluateManualVotingToHundred', () => {
    test('allows voting when exposure is below 100%', () => {
        const challenge = buildChallenge({ exposureFactor: 75 });
        const result = VotingLogic.evaluateManualVotingToHundred(challenge, NOW(), challenge.title);

        expect(result.shouldAllowVoting).toBe(true);
        expect(result.errorMessage).toBe('');
        expect(result.targetExposure).toBe(100);
    });

    test('blocks voting when exposure is already 100%', () => {
        const challenge = buildChallenge({ exposureFactor: 100 });
        const result = VotingLogic.evaluateManualVotingToHundred(challenge, NOW(), challenge.title);

        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toContain('already has 100% exposure');
        expect(result.targetExposure).toBe(100);
    });

    test('blocks voting when challenge has not started', () => {
        const challenge = buildChallenge({ exposureFactor: 50, startInSeconds: 3600, closeInSeconds: 7200 });
        const result = VotingLogic.evaluateManualVotingToHundred(challenge, NOW(), challenge.title);

        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toContain('has not started yet');
    });

    test('blocks voting when challenge has ended', () => {
        const challenge = buildChallenge({ exposureFactor: 50, startInSeconds: -7200, closeInSeconds: -60 });
        const result = VotingLogic.evaluateManualVotingToHundred(challenge, NOW(), challenge.title);

        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toContain('already ended');
    });

    test('always targets 100% regardless of threshold settings', () => {
        // Manual mode bypasses threshold/exposure settings — confirm by varying exposure
        // through plausible threshold values; targetExposure must stay 100.
        for (const exposureFactor of [10, 40, 50, 75, 99]) {
            const challenge = buildChallenge({ exposureFactor });
            const result = VotingLogic.evaluateManualVotingToHundred(challenge, NOW(), challenge.title);
            expect(result.targetExposure).toBe(100);
            expect(result.shouldAllowVoting).toBe(true);
        }
    });

    test('uses the supplied challengeTitle in error messages', () => {
        const challenge = buildChallenge({ exposureFactor: 100 });
        const result = VotingLogic.evaluateManualVotingToHundred(challenge, NOW(), 'Sunset over Riga');
        expect(result.errorMessage).toContain('Sunset over Riga');
    });
});
