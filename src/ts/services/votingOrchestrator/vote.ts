import * as logger from '../../logger';
import * as cancellation from '../../voting/cancellation';
import { cancelPass } from './context';
import { failureText } from '../../format/logSafe';
import { sleep } from '../../timing';

import type { Challenge, VoteImagesResponse } from '../../types/gurushots';
import type { VotingPassResult } from '../../types/votingPass';
import type { PassContext } from './context';

/**
 * Submit votes from an already-fetched pool, then pace before the next challenge.
 *
 * @param onVoteLanded - records the snapshot when a cancel follows a landed vote
 * @returns the cancelled-pass result, or null to continue
 */
const submitVoteImages = async (
    challenge: Challenge,
    voteImages: VoteImagesResponse,
    targetExposure: number,
    pass: PassContext,
    onVoteLanded: () => void,
    maxVotes?: number,
): Promise<VotingPassResult | null> => {
    if (cancellation.isCancelled()) {
        return cancelPass(pass.allChallenges, '🛑 Voting cancelled by user before vote submission');
    }

    logger
        .withCategory('voting')
        .infoT(
            'mc0e03d96165c',
            [logger.challengeTag(challenge), Math.min(voteImages.images.length, maxVotes ?? Infinity)],
            null,
        );

    // Submit votes to target exposure (dynamic based on voting rules)
    await pass.api.submitVotes(voteImages, pass.token, targetExposure, maxVotes);

    if (cancellation.isCancelled()) {
        // The vote already went through, so the trigger is spent —
        // record before bailing or the next pass re-votes it.
        onVoteLanded();
        return cancelPass(pass.allChallenges, '🛑 Voting cancelled by user after vote submission');
    }

    logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'voting attempt complete');

    // Add a delay between challenges (strategy-specific pacing)
    const delay = pass.interChallengeDelay();
    logger.withCategory('voting').debug(`Adding ${delay}ms delay between challenges`, null);
    await sleep(delay);
    return null;
};

type VoteOutcome = {
    cancelled: VotingPassResult | null;
    voteThrew: boolean;
    votePool: VoteImagesResponse | null | undefined;
};

/**
 * Vote on the challenge when the decision says so.
 *
 * `votePool` is the pool this pass voted from — handed to the exposure-fill
 * rule, which only spends when voting cannot reach its threshold. undefined =
 * voting didn't run (the rule fetches the pool itself); null = none.
 *
 * @param maxVotes - caps the photos voted on (a vote mission's share)
 */
export const voteOnChallenge = async (
    challenge: Challenge,
    decision: { shouldVote: boolean; voteReason: string; targetExposure: number },
    pass: PassContext,
    onVoteLanded: () => void,
    maxVotes?: number,
): Promise<VoteOutcome> => {
    const outcome: VoteOutcome = { cancelled: null, voteThrew: false, votePool: undefined };
    if (!decision.shouldVote) {
        logger
            .withCategory('voting')
            .infoT('md9eea27255b5', [logger.challengeTag(challenge), decision.voteReason], null);
        return outcome;
    }

    logger
        .withCategory('voting')
        .startOperation(`vote-${challenge.id}`, `Voting on ${logger.challengeTag(challenge)}`, 'DEBUG');

    try {
        if (cancellation.isCancelled()) {
            outcome.cancelled = cancelPass(
                pass.allChallenges,
                '🛑 Voting cancelled by user during challenge processing',
            );
            return outcome;
        }

        logger
            .withCategory('voting')
            .infoT('me55acfad2b92', [logger.challengeTag(challenge), decision.voteReason], null);

        const voteImages = await pass.api.getVoteImages(challenge, pass.token);
        // The body (an empty images array included) is handed to the fill step whole, like any other.
        outcome.votePool = voteImages ?? null;
        // Only a pool with images to vote on is voted: an empty pool is a real
        // answer (nothing left), a null one a failed read — both skip the vote.
        if (voteImages && Array.isArray(voteImages.images) && voteImages.images.length > 0) {
            outcome.cancelled = await submitVoteImages(
                challenge,
                voteImages,
                decision.targetExposure,
                pass,
                onVoteLanded,
                maxVotes,
            );
        } else {
            // No images is a valid "nothing to do" state — close the op as a
            // DEBUG success (silent) and surface one WARN for user visibility.
            logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'no vote images available');
            logger.withCategory('voting').warningT('m8dc9275e52f1', [logger.challengeTag(challenge)], null);
        }
    } catch (error) {
        outcome.voteThrew = true;
        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, null, failureText(error));
    }
    return outcome;
};
