/**
 * BaseMiddleware.cliVoteManual — the CLI's "vote everything to 100%" command.
 *
 * getActiveChallenges always resolves a list shape and never null, so checking
 * `!challengesResponse.challenges` never catches a failure. An API outage must not fall
 * through to voting an empty list and reporting "Manual vote: 0 voted, 0 skipped of 0" —
 * the same "an outage looks like a healthy empty pass" misreport runVotingPass guards
 * against, on this second entry point.
 */

jest.mock('../../src/js/settings', () => ({
    getSetting: jest.fn(() => 'tok'),
}));

jest.mock('../../src/js/services/manualVote', () => ({
    voteAllChallengesManual: jest.fn(async () => ({ voted: 0, skipped: 0 })),
}));

const settings = require('../../src/js/settings');
const { voteAllChallengesManual } = require('../../src/js/services/manualVote');
const BaseMiddleware = require('../../src/js/services/BaseMiddleware');

const makeMiddleware = (getActiveChallenges) =>
    new BaseMiddleware({
        getActiveChallenges: jest.fn(getActiveChallenges),
    });

describe('cliVoteManual — failed challenge fetch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        settings.getSetting.mockReturnValue('tok');
    });

    test('does not vote when the fetch failed', async () => {
        const middleware = makeMiddleware(async () => ({ challenges: [], fetchFailed: true }));

        await middleware.cliVoteManual();

        // The load-bearing assertion: an outage must not be voted as an empty account.
        expect(voteAllChallengesManual).not.toHaveBeenCalled();
    });

    test('votes normally when the fetch succeeded', async () => {
        const challenges = [{ id: '1' }, { id: '2' }];
        const middleware = makeMiddleware(async () => ({ challenges }));

        await middleware.cliVoteManual();

        expect(voteAllChallengesManual).toHaveBeenCalledWith(challenges, expect.anything(), 'tok');
    });

    test('a genuinely empty account still runs the (no-op) vote pass', async () => {
        // The other half of the distinction — nothing to vote is not an error.
        const middleware = makeMiddleware(async () => ({ challenges: [] }));

        await middleware.cliVoteManual();

        expect(voteAllChallengesManual).toHaveBeenCalledWith([], expect.anything(), 'tok');
    });

    test('does nothing without a token', async () => {
        settings.getSetting.mockReturnValue('');
        const middleware = makeMiddleware(async () => ({ challenges: [{ id: '1' }] }));

        await middleware.cliVoteManual();

        expect(voteAllChallengesManual).not.toHaveBeenCalled();
    });
});
