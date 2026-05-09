/**
 * Manual-vote helpers shared by CLI (BaseMiddleware.cliVoteManual) and
 * Electron IPC (voting.handlers.js). The rule is "vote a challenge to 100%
 * regardless of threshold settings" — the shape of the per-challenge
 * mechanic is identical across shells, only the surrounding logging
 * differs, so it lives here as a single function and each caller formats
 * its own progress output.
 */

const votingLogic = require('./VotingLogic');

/**
 * Spacing between successful manual votes within a single cycle. Both
 * the CLI loop (BaseMiddleware.cliVoteManual) and the IPC vote-all
 * handler import this so the cadence stays in sync if it's ever tuned.
 * Honors the project's "stagger over batch" rule.
 */
const STAGGER_MS = 1000;

/**
 * Run the manual (vote-to-100%) mechanic for one challenge.
 *
 * Returns one of three outcomes the caller can format:
 *   { outcome: 'not-eligible', errorMessage }
 *   { outcome: 'no-images',    targetExposure }
 *   { outcome: 'voted',        targetExposure, imageCount }
 */
const submitVotesForChallenge = async (challenge, strategy, token, now) => {
    const { shouldAllowVoting, errorMessage, targetExposure } = votingLogic.evaluateManualVotingToHundred(
        challenge,
        now,
        challenge.title,
    );
    if (!shouldAllowVoting) {
        return { outcome: 'not-eligible', errorMessage };
    }

    const voteImages = await strategy.getVoteImages(challenge, token);
    if (!voteImages || !voteImages.images || voteImages.images.length === 0) {
        return { outcome: 'no-images', targetExposure };
    }

    await strategy.submitVotes(voteImages, token, targetExposure);
    return { outcome: 'voted', targetExposure, imageCount: voteImages.images.length };
};

module.exports = { submitVotesForChallenge, STAGGER_MS };
