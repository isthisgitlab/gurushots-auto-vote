/**
 * Voting-cycle IPC handlers. Covers the entry points the renderer
 * uses to drive a voting pass:
 *   - gui-vote: middleware vote, used by the GUI's main vote button
 *   - run-voting-cycle: full per-challenge cycle (autovote core)
 *   - run-voting-cycle-for-challenge: same strategy, scoped to one challenge
 *   - vote-all-challenges-manual: bypass all thresholds
 *   - vote-on-challenge / vote-on-challenge-manual: target one
 *     challenge; the two channels carry slightly different log wording
 *     but exercise the same code path
 *   - should-cancel-voting / set-cancel-voting: cancellation-flag
 *     read/write, delegated to voting/cancellation.js
 */

const settings = require('../settings');
const logger = require('../logger');
const apiFactory = require('../apiFactory');
const votingLogic = require('../services/VotingLogic');
const cancellation = require('../voting/cancellation');

// Run one full strategy pass — global when challengeId is null, scoped
// to a single card otherwise. Delegates to BaseMiddleware so the
// auth-check, cancellation-reset, and IPC-envelope shape live in one
// place that the gui-vote handler also reaches via guiVote().
const runStrategyOnceViaMiddleware = (challengeId = null) => apiFactory.getMiddleware().runVotingCycle(challengeId);

// Per-challenge vote mechanic shared by the single-target handlers and
// the vote-all loop. Returns the outcome so each caller can log/count
// in its own wording without re-implementing eligibility + image fetch
// + submit.
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

// Single-target vote entry shared by vote-on-challenge and
// vote-on-challenge-manual. The two channels carried slightly different
// log wording but exercised the same code path; the `manual` flag now
// flips just those wording bits.
const voteOnSingleChallenge = async (challengeId, challengeTitle, { manual }) => {
    const requestPrefix = manual ? '🔄 Manual vote on challenge request' : '🔄 Vote on challenge request';
    logger
        .withCategory('general')
        .info(`${requestPrefix}: ID=${challengeId}, Title="${challengeTitle}"`, null, logger.CATEGORIES.VOTING);

    const userSettings = settings.loadSettings();
    if (!userSettings.token) {
        const noTokenMsg = manual ? '❌ No token found for manual voting' : '❌ No token found for voting';
        logger.withCategory('authentication').warning(noTokenMsg, null);
        return { success: false, error: 'No authentication token found' };
    }

    const strategy = apiFactory.getApiStrategy();
    const challengesResponse = await strategy.getActiveChallenges(userSettings.token);

    if (!challengesResponse || !challengesResponse.challenges) {
        const fetchMsg = manual
            ? '❌ Failed to fetch challenges for manual voting'
            : '❌ Failed to fetch challenges for voting';
        logger.withCategory('challenges').warning(fetchMsg, null);
        return { success: false, error: 'Failed to fetch challenges' };
    }

    logger
        .withCategory('challenges')
        .debug(`📋 Found challenges: [${challengesResponse.challenges.map((c) => `${c.id}:"${c.title}"`).join(', ')}]`);
    logger.withCategory('challenges').debug('🔍 Looking for challenge ID:', challengeId);

    const challenge = challengesResponse.challenges.find((c) => c.id === parseInt(challengeId));
    logger
        .withCategory('general')
        .debug(
            `🎯 Challenge found: ${challenge ? `ID=${challenge.id}, Title="${challenge.title}"` : 'NOT FOUND'}`,
            null,
            logger.CATEGORIES.CHALLENGES,
        );

    if (!challenge) {
        logger
            .withCategory('general')
            .warning('❌ Challenge not found:', { challengeId, challengeTitle }, logger.CATEGORIES.CHALLENGES);
        return { success: false, error: `Challenge "${challengeTitle}" not found` };
    }

    const now = Math.floor(Date.now() / 1000);
    if (challenge.start_time >= now) {
        return { success: false, error: `Challenge "${challengeTitle}" has not started yet` };
    }

    const startMsg = manual
        ? '🗳️ Starting manual voting process for challenge:'
        : '🗳️ Starting voting process for challenge:';
    logger.withCategory('voting').info(startMsg, challenge.title);

    const result = await submitVotesForChallenge(challenge, strategy, userSettings.token, now);
    if (result.outcome === 'not-eligible') {
        return { success: false, error: result.errorMessage };
    }

    logger
        .withCategory('voting')
        .debug(
            `📸 Vote images received: ${result.outcome === 'no-images' ? 'No vote images' : `Count=${result.imageCount}`}`,
            null,
        );

    if (result.outcome === 'no-images') {
        const noImagesMsg = manual ? '⚠️ No vote images available for manual voting' : '⚠️ No vote images available';
        logger.withCategory('voting').warning(noImagesMsg, null);
    } else {
        const submittingMsg = manual ? '✅ Submitting manual votes...' : '✅ Submitting votes...';
        logger.withCategory('voting').info(submittingMsg, null);
        const successMsg = manual ? '✅ Manual votes submitted successfully' : '✅ Votes submitted successfully';
        logger.withCategory('voting').success(successMsg);
    }

    const successReturnMsg = manual
        ? `Successfully voted on challenge "${challengeTitle}" manually`
        : `Successfully voted on challenge "${challengeTitle}"`;
    return { success: true, message: successReturnMsg };
};

const buildHandlers = () => ({
    'gui-vote': async () => {
        try {
            const userSettings = settings.loadSettings();
            if (!userSettings.token) {
                return { success: false, error: 'No authentication token found' };
            }
            const middleware = apiFactory.getMiddleware();
            return await middleware.guiVote();
        } catch (error) {
            logger.withCategory('voting').error('Error handling gui-vote request:', error);
            return { success: false, error: error.message || 'Failed to load challenges' };
        }
    },

    'run-voting-cycle': async () => {
        try {
            logger.withCategory('voting').info('🔄 Starting voting cycle...', null);
            return await runStrategyOnceViaMiddleware(null);
        } catch (error) {
            logger.withCategory('voting').error('Error handling run-voting-cycle request:', error);
            return { success: false, error: error.message || 'Failed to run voting cycle' };
        }
    },

    'run-voting-cycle-for-challenge': async (_event, challengeId) => {
        try {
            if (challengeId == null || challengeId === '') {
                return { success: false, error: 'challengeId is required' };
            }
            logger.withCategory('voting').info(`🔄 Starting single-challenge cycle: ${challengeId}`, null);
            return await runStrategyOnceViaMiddleware(challengeId);
        } catch (error) {
            logger.withCategory('voting').error('Error handling run-voting-cycle-for-challenge request:', error);
            return { success: false, error: error.message || 'Failed to run voting cycle' };
        }
    },

    'vote-all-challenges-manual': async () => {
        try {
            logger.withCategory('voting').info('🔄 Starting manual vote all challenges (bypass thresholds)...', null);

            const userSettings = settings.loadSettings();
            if (!userSettings.token) {
                logger.withCategory('authentication').warning('❌ No token found for manual voting', null);
                return { success: false, error: 'No authentication token found' };
            }

            const strategy = apiFactory.getApiStrategy();

            const challengesResponse = await strategy.getActiveChallenges(userSettings.token);
            if (!challengesResponse || !challengesResponse.challenges) {
                logger.withCategory('challenges').warning('❌ Failed to fetch challenges for manual vote all', null);
                return { success: false, error: 'Failed to fetch challenges' };
            }

            const challenges = challengesResponse.challenges;
            const now = Math.floor(Date.now() / 1000);
            let processedCount = 0;
            let votedCount = 0;
            let skippedCount = 0;

            logger.withCategory('voting').info(`📋 Found ${challenges.length} challenges to process`, null);

            for (const challenge of challenges) {
                processedCount++;
                logger
                    .withCategory('voting')
                    .progress(
                        `Processing challenge ${processedCount}/${challenges.length}: ${challenge.title}`,
                        processedCount,
                        challenges.length,
                    );

                try {
                    const result = await submitVotesForChallenge(challenge, strategy, userSettings.token, now);
                    if (result.outcome === 'voted') {
                        votedCount++;
                        logger
                            .withCategory('voting')
                            .success(
                                `✅ Voted on challenge: ${challenge.title} (target: ${result.targetExposure}%)`,
                                null,
                            );
                        await new Promise((resolve) => setTimeout(resolve, 1000));
                    } else if (result.outcome === 'no-images') {
                        logger
                            .withCategory('voting')
                            .warning(`⚠️ No vote images available for: ${challenge.title}`, null);
                        skippedCount++;
                    } else {
                        logger
                            .withCategory('voting')
                            .info(`⏭️ Skipping challenge: ${challenge.title} - ${result.errorMessage}`, null);
                        skippedCount++;
                    }
                } catch (error) {
                    logger.withCategory('voting').error(`❌ Error voting on challenge ${challenge.title}:`, error);
                    skippedCount++;
                }
            }

            const message = `Manual vote all completed: ${votedCount} voted, ${skippedCount} skipped out of ${challenges.length} challenges`;
            logger.withCategory('voting').success(message, null);

            return {
                success: true,
                message,
                stats: { total: challenges.length, voted: votedCount, skipped: skippedCount },
            };
        } catch (error) {
            logger.withCategory('voting').error('Error handling vote-all-challenges-manual request:', error);
            return { success: false, error: error.message || 'Failed to vote on all challenges manually' };
        }
    },

    'should-cancel-voting': () => cancellation.isCancelled(),

    'set-cancel-voting': (event, shouldCancel) => {
        cancellation.setCancelled(shouldCancel);
        return cancellation.isCancelled();
    },

    'vote-on-challenge': async (event, challengeId, challengeTitle) => {
        try {
            return await voteOnSingleChallenge(challengeId, challengeTitle, { manual: false });
        } catch (error) {
            logger.withCategory('voting').error('Error handling vote-on-challenge request:', error);
            return { success: false, error: error.message || 'Failed to vote on challenge' };
        }
    },

    'vote-on-challenge-manual': async (event, challengeId, challengeTitle) => {
        try {
            return await voteOnSingleChallenge(challengeId, challengeTitle, { manual: true });
        } catch (error) {
            logger.withCategory('voting').error('Error handling vote-on-challenge-manual request:', error);
            return { success: false, error: error.message || 'Failed to vote on challenge manually' };
        }
    },
});

const register = (ipcMain) => {
    const handlers = buildHandlers();
    for (const [channel, impl] of Object.entries(handlers)) {
        ipcMain.handle(channel, impl);
    }
};

module.exports = { register, buildHandlers };
