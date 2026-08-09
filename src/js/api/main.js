/**
 * GuruShots Auto Voter - Main Orchestration Module
 *
 * This module orchestrates all the voting operations by coordinating
 * between challenges, voting, and boost modules.
 */

const { getActiveChallenges } = require('./challenges');
const { getVoteImages, submitVotes } = require('./voting');
const { applyBoost, applyBoostToEntry } = require('./boost');
const { getChallengeTurbo, submitTurboSelection, applyTurbo, TURBO_SELECTION_DELAY_MS } = require('./turbo');
const { getEligiblePhotos, submitToChallenge } = require('./submissions');
const { cleanupStaleMetadata } = require('../metadata');
const { sleep, getRandomDelay } = require('../timing');
const logger = require('../logger');
const { runVotingPass } = require('../services/votingOrchestrator');
const { createMetadataEntryTracker } = require('../services/newEntryTracker');

// One instance for the process: the tracker is stateless (it reads and writes
// metadata.json on each call), but building it per pass would be pointless churn.
const metadataEntryTracker = createMetadataEntryTracker();

/**
 * Plays through the Turbo mini-game for a single challenge.
 * Iterates pair-by-pair, picks first_image, flips to second_image on a wrong
 * pick, and stops early once the response reports state === 'WON'.
 */
const runTurboMiniGame = async (challenge, token) => {
    const set = await getChallengeTurbo(challenge.id, token);
    if (!set) {
        logger.withCategory('turbo').warning(`${logger.challengeTag(challenge)} No turbo battle set returned`, null);
        return { played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false };
    }

    let played = 0;
    let correct = 0;
    let flipped = 0;
    let doubleFailed = 0;
    let won = false;

    for (const battle of set.battles) {
        if (battle.isSuccess !== null) continue;
        if (!battle.firstImageId || !battle.secondImageId) {
            doubleFailed++;
            continue;
        }

        played++;
        const first = await submitTurboSelection(challenge.id, battle.firstImageId, token);
        if (first.ok) {
            correct++;
            if (first.state === 'WON') {
                won = true;
                break;
            }
            await sleep(TURBO_SELECTION_DELAY_MS);
            continue;
        }

        // First pick lost or errored — flip to the other image.
        await sleep(TURBO_SELECTION_DELAY_MS);
        const second = await submitTurboSelection(challenge.id, battle.secondImageId, token);
        if (second.ok) {
            correct++;
            flipped++;
            if (second.state === 'WON') {
                won = true;
                break;
            }
        } else {
            doubleFailed++;
            const code = second.errorCode || first.errorCode;
            if (code) {
                logger
                    .withCategory('turbo')
                    .warning(`${logger.challengeTag(challenge)} Turbo battle skipped, error_code=${code}`, null);
            }
        }
        await sleep(TURBO_SELECTION_DELAY_MS);
    }

    return { played, correct, flipped, doubleFailed, won };
};

/**
 * Main function that fetches active challenges and processes them — thin
 * binder over the shared orchestration (services/votingOrchestrator.js),
 * which real and mock strategies both run. The endpoint references are
 * passed per call (not at module load) so jest.mock'd api modules keep
 * working in the existing suites.
 *
 * @param {string} token - Authentication token
 * @param {number|function} [_getExposureThreshold] - Optional exposure-threshold resolver kept for caller backward-compat; unused internally (the voting-logic service reads settings directly).
 * @param {string|number} [challengeIdFilter] - When set, restricts the strategy pass to a single challenge (per-card "Run"). Stale-metadata cleanup still runs against the full active list before filtering.
 * @returns {Promise<{success:boolean, message?:string, error?:string, challenges?:Array}>}
 *   `challenges` is the *full* active list this cycle fetched (not the per-challenge
 *   filtered subset), so callers can reuse it for threshold scheduling instead of
 *   re-fetching. Absent only when the fetch itself threw before a list was obtained.
 */
const fetchChallengesAndVote = async (token, _getExposureThreshold = null, challengeIdFilter = null) =>
    runVotingPass(token, challengeIdFilter, {
        api: {
            getActiveChallenges,
            getVoteImages,
            submitVotes,
            applyBoost,
            applyBoostToEntry,
            applyTurbo,
            getEligiblePhotos,
            submitToChallenge,
            runTurboMiniGame,
        },
        cleanupStaleMetadata,
        // Real mode persists new-entry snapshots to metadata.json, where
        // cleanupStaleMetadata prunes them alongside their challenge.
        entryTracker: metadataEntryTracker,
        // Random 2-5s spacing between challenges to mimic human behavior.
        interChallengeDelay: () => getRandomDelay(2000, 5000),
    });

module.exports = {
    fetchChallengesAndVote,
    applyBoostToEntry,
    runTurboMiniGame,
};
