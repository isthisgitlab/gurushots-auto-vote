/**
 * Manual-vote helpers shared by CLI (BaseMiddleware.cliVoteManual) and
 * Electron IPC (voting.handlers.ts). The rule is "vote a challenge to 100%
 * regardless of threshold settings" — the shape of the per-challenge
 * mechanic is identical across shells, only the surrounding logging
 * differs, so it lives here as a single function and each caller formats
 * its own progress output.
 */

import * as votingLogic from './VotingLogic';
import * as logger from '../logger';
import * as settings from '../settings';
import { isManualPhotosOnly } from './manualPhotosOnly';
import { isMarkedChallenge } from '../challengeMarks';
import { manualOnlyOnLine } from './votingOrchestrator/manualOnly';

import type { ApiStrategy } from '../apiFactory';
import type { Challenge } from '../types/gurushots';

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
 *
 * A challenge the boundary marked (its data cannot be read) is refused before
 * anything is evaluated: 'not-eligible' with the reason, which both the
 * single-card handler and the vote-all loop already surface.
 *
 * @param strategy - API strategy (real or mock)
 * @param now - Unix seconds
 */
const submitVotesForChallenge = async (challenge: Challenge, strategy: ApiStrategy, token: string, now: number) => {
    if (isMarkedChallenge(challenge)) {
        return { outcome: 'not-eligible', errorMessage: 'challenge data cannot be read' };
    }
    const { shouldAllowVoting, errorMessage, targetExposure } = votingLogic.evaluateManualVotingToHundred(
        challenge,
        now,
        challenge.title,
    ) as { shouldAllowVoting: boolean; errorMessage: string; targetExposure: number };
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

/**
 * Run the manual mechanic over a whole challenge list: vote every eligible
 * challenge to 100%, spacing successful submissions by STAGGER_MS, logging
 * each outcome, and counting results. A Manual Only challenge is skipped (and
 * counted in `skipped`): this bulk vote works on every challenge at once, so
 * only the card's own vote button votes there. If reading the switch throws, the
 * challenge counts as skipped through the error path. Shared by the CLI loop
 * (BaseMiddleware.cliVoteManual) and the IPC vote-all handler so the loop
 * semantics can never drift between shells.
 *
 * @param strategy - API strategy (real or mock)
 * @param opts.staggerMs - Override for tests; production callers keep STAGGER_MS.
 */
const voteAllChallengesManual = async (
    challenges: Challenge[],
    strategy: ApiStrategy,
    token: string,
    {
        onProgress,
        staggerMs = STAGGER_MS,
    }: { onProgress?: (current: number, total: number, challenge: Challenge) => void; staggerMs?: number } = {},
): Promise<{ voted: number; skipped: number; total: number }> => {
    const now = Math.floor(Date.now() / 1000);
    let voted = 0;
    let skipped = 0;
    let processed = 0;
    for (const challenge of challenges) {
        processed++;
        if (onProgress) onProgress(processed, challenges.length, challenge);
        try {
            if (isManualPhotosOnly(settings, challenge.id)) {
                skipped++;
                logger.withCategory('voting').info(manualOnlyOnLine(challenge), null);
                continue;
            }
            const result = await submitVotesForChallenge(challenge, strategy, token, now);
            if (result.outcome === 'voted') {
                voted++;
                logger
                    .withCategory('voting')
                    .success(`✅ ${logger.challengeTag(challenge)} Voted (target: ${result.targetExposure}%)`, null);
                await new Promise((resolve) => {
                    setTimeout(resolve, staggerMs);
                });
            } else if (result.outcome === 'no-images') {
                skipped++;
                logger
                    .withCategory('voting')
                    .warning(`⚠️ ${logger.challengeTag(challenge)} No vote images available`, null);
            } else {
                skipped++;
                logger
                    .withCategory('voting')
                    .info(`⏭️ ${logger.challengeTag(challenge)} Skipping - ${result.errorMessage}`, null);
            }
        } catch (error) {
            skipped++;
            logger.withCategory('voting').error(`❌ ${logger.challengeTag(challenge)} Error voting:`, error);
        }
    }
    return { voted, skipped, total: challenges.length };
};

export { submitVotesForChallenge, voteAllChallengesManual, STAGGER_MS };
