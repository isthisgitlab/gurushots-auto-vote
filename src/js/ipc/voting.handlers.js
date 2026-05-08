/**
 * Voting-cycle IPC handlers. Covers the entry points the renderer
 * uses to drive a voting pass:
 *   - gui-vote: middleware vote, used by the GUI's main vote button
 *   - run-voting-cycle: full per-challenge cycle (autovote core)
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

const register = (ipcMain) => {
    ipcMain.handle('gui-vote', async () => {
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
    });

    ipcMain.handle('run-voting-cycle', async () => {
        try {
            logger.withCategory('voting').info('🔄 Starting voting cycle...', null);

            const userSettings = settings.loadSettings();
            if (!userSettings.token) {
                logger.withCategory('authentication').warning('❌ No token found for voting cycle', null);
                return { success: false, error: 'No authentication token found' };
            }

            const strategy = apiFactory.getApiStrategy();

            // Per-challenge override resolver. Schema default is the
            // last-resort fallback so a corrupt override doesn't stall
            // a whole cycle.
            const getExposureThreshold = (challengeId) => {
                try {
                    return settings.getEffectiveSetting('exposure', challengeId);
                } catch (error) {
                    logger
                        .withCategory('settings')
                        .warning(`Error getting exposure setting for challenge ${challengeId}:`, error);
                    return settings.SETTINGS_SCHEMA.exposure.default;
                }
            };

            cancellation.reset();

            const result = await strategy.fetchChallengesAndVote(userSettings.token, getExposureThreshold);

            if (result && result.success) {
                return { success: true, message: result.message || 'Voting cycle completed successfully' };
            }
            return { success: false, error: result?.error || 'Voting cycle failed' };
        } catch (error) {
            logger.withCategory('voting').error('Error handling run-voting-cycle request:', error);
            return { success: false, error: error.message || 'Failed to run voting cycle' };
        }
    });

    ipcMain.handle('vote-all-challenges-manual', async () => {
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

                const { shouldAllowVoting, errorMessage, targetExposure } = votingLogic.evaluateManualVotingToHundred(
                    challenge,
                    now,
                    challenge.title,
                );

                if (shouldAllowVoting) {
                    try {
                        logger
                            .withCategory('voting')
                            .info(`🗳️ Voting on challenge: ${challenge.title} (target: ${targetExposure}%)`, null);
                        const voteImages = await strategy.getVoteImages(challenge, userSettings.token);
                        if (voteImages && voteImages.images && voteImages.images.length > 0) {
                            await strategy.submitVotes(voteImages, userSettings.token, targetExposure);
                            votedCount++;
                            logger.withCategory('voting').success(`✅ Voted on challenge: ${challenge.title}`, null);
                            await new Promise((resolve) => setTimeout(resolve, 1000));
                        } else {
                            logger
                                .withCategory('voting')
                                .warning(`⚠️ No vote images available for: ${challenge.title}`, null);
                            skippedCount++;
                        }
                    } catch (error) {
                        logger.withCategory('voting').error(`❌ Error voting on challenge ${challenge.title}:`, error);
                        skippedCount++;
                    }
                } else {
                    logger
                        .withCategory('voting')
                        .info(`⏭️ Skipping challenge: ${challenge.title} - ${errorMessage}`, null);
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
    });

    ipcMain.handle('should-cancel-voting', () => cancellation.isCancelled());

    ipcMain.handle('set-cancel-voting', (event, shouldCancel) => {
        cancellation.setCancelled(shouldCancel);
        return cancellation.isCancelled();
    });

    ipcMain.handle('vote-on-challenge', async (event, challengeId, challengeTitle) => {
        try {
            logger
                .withCategory('general')
                .info(
                    `🔄 Vote on challenge request: ID=${challengeId}, Title="${challengeTitle}"`,
                    null,
                    logger.CATEGORIES.VOTING,
                );

            const userSettings = settings.loadSettings();
            if (!userSettings.token) {
                logger.withCategory('authentication').warning('❌ No token found for voting', null);
                return { success: false, error: 'No authentication token found' };
            }

            const strategy = apiFactory.getApiStrategy();
            const challengesResponse = await strategy.getActiveChallenges(userSettings.token);

            if (!challengesResponse || !challengesResponse.challenges) {
                logger.withCategory('challenges').warning('❌ Failed to fetch challenges for voting', null);
                return { success: false, error: 'Failed to fetch challenges' };
            }

            logger
                .withCategory('challenges')
                .debug(
                    `📋 Found challenges: [${challengesResponse.challenges.map((c) => `${c.id}:"${c.title}"`).join(', ')}]`,
                );
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

            const { shouldAllowVoting, errorMessage, targetExposure } = votingLogic.evaluateManualVotingToHundred(
                challenge,
                now,
                challengeTitle,
            );
            if (!shouldAllowVoting) {
                return { success: false, error: errorMessage };
            }

            logger.withCategory('voting').info('🗳️ Starting voting process for challenge:', challenge.title);
            const voteImages = await strategy.getVoteImages(challenge, userSettings.token);
            logger
                .withCategory('voting')
                .debug(
                    `📸 Vote images received: ${voteImages ? `Count=${voteImages.images?.length}` : 'No vote images'}`,
                    null,
                );

            if (voteImages && voteImages.images && voteImages.images.length > 0) {
                logger.withCategory('voting').info('✅ Submitting votes...', null);
                await strategy.submitVotes(voteImages, userSettings.token, targetExposure);
                logger.withCategory('voting').success('✅ Votes submitted successfully');
            } else {
                logger.withCategory('voting').warning('⚠️ No vote images available', null);
            }

            return { success: true, message: `Successfully voted on challenge "${challengeTitle}"` };
        } catch (error) {
            logger.withCategory('voting').error('Error handling vote-on-challenge request:', error);
            return { success: false, error: error.message || 'Failed to vote on challenge' };
        }
    });

    ipcMain.handle('vote-on-challenge-manual', async (event, challengeId, challengeTitle) => {
        try {
            logger
                .withCategory('general')
                .info(
                    `🔄 Manual vote on challenge request: ID=${challengeId}, Title="${challengeTitle}"`,
                    null,
                    logger.CATEGORIES.VOTING,
                );

            const userSettings = settings.loadSettings();
            if (!userSettings.token) {
                logger.withCategory('authentication').warning('❌ No token found for manual voting', null);
                return { success: false, error: 'No authentication token found' };
            }

            const strategy = apiFactory.getApiStrategy();
            const challengesResponse = await strategy.getActiveChallenges(userSettings.token);

            if (!challengesResponse || !challengesResponse.challenges) {
                logger.withCategory('challenges').warning('❌ Failed to fetch challenges for manual voting', null);
                return { success: false, error: 'Failed to fetch challenges' };
            }

            logger
                .withCategory('challenges')
                .debug(
                    `📋 Found challenges: [${challengesResponse.challenges.map((c) => `${c.id}:"${c.title}"`).join(', ')}]`,
                );
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

            const { shouldAllowVoting, errorMessage, targetExposure } = votingLogic.evaluateManualVotingToHundred(
                challenge,
                now,
                challengeTitle,
            );
            if (!shouldAllowVoting) {
                return { success: false, error: errorMessage };
            }

            logger.withCategory('voting').info('🗳️ Starting manual voting process for challenge:', challenge.title);
            const voteImages = await strategy.getVoteImages(challenge, userSettings.token);
            logger
                .withCategory('voting')
                .debug(
                    `📸 Vote images received: ${voteImages ? `Count=${voteImages.images?.length}` : 'No vote images'}`,
                    null,
                );

            if (voteImages && voteImages.images && voteImages.images.length > 0) {
                logger.withCategory('voting').info('✅ Submitting manual votes...', null);
                await strategy.submitVotes(voteImages, userSettings.token, targetExposure);
                logger.withCategory('voting').success('✅ Manual votes submitted successfully');
            } else {
                logger.withCategory('voting').warning('⚠️ No vote images available for manual voting', null);
            }

            return { success: true, message: `Successfully voted on challenge "${challengeTitle}" manually` };
        } catch (error) {
            logger.withCategory('voting').error('Error handling vote-on-challenge-manual request:', error);
            return { success: false, error: error.message || 'Failed to vote on challenge manually' };
        }
    });
};

module.exports = { register };
