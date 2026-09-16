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
const { getEligiblePhotos, getImageData, submitToChallenge } = require('./submissions');
const { getCurrentMemberProfile, searchTagAutocomplete } = require('./tags');
const { getMemberChallenges, getBankroll, coinsUnlock } = require('./join');
const { cleanupStaleMetadata } = require('../metadata');
const { sleep, getRandomDelay } = require('../timing');
const logger = require('../logger');
const { runVotingPass } = require('../services/votingOrchestrator');
const { createMetadataEntryTracker } = require('../services/newEntryTracker');
const { runJoinPass, joinChallengeSingle } = require('../services/joinChallenges');
const { joinStateStore, acquireUnlockLock } = require('../joinStateStore');

// One instance for the process: the tracker is stateless (it reads and writes
// metadata.json on each call), but building it per pass would be pointless churn.
const metadataEntryTracker = createMetadataEntryTracker();

// Deps bundle shared by the automatic join pass and the manual single-join path.
// joinStateStore persists the paid-unlock markers; acquireUnlockLock guards the
// unlock critical section across processes (real strategy only — mock passes a
// null store and no lock).
const joinDeps = {
    getMemberChallenges,
    getBankroll,
    coinsUnlock,
    submitToChallenge,
    getEligiblePhotos,
    // Tag resolution for the join flow's photo pick. pickJoinPhoto reads these
    // off deps and no-ops without them, so omitting the pair here silently
    // reverts joins to unfiltered-library behavior.
    getCurrentMemberProfile,
    searchTagAutocomplete,
    joinStateStore,
    acquireUnlockLock,
};

/**
 * Manual single-challenge join (real strategy). Paid joins require an explicit
 * `spendCoins` — otherwise the call returns `needs-confirm` and spends nothing.
 * @param {string|number} challengeId
 * @param {boolean} spendCoins
 * @param {string} token
 */
const joinChallenge = (challengeId, spendCoins, token) =>
    joinChallengeSingle(challengeId, token, joinDeps, { spendCoins: spendCoins === true });

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
const fetchChallengesAndVote = async (token, _getExposureThreshold = null, challengeIdFilter = null) => {
    // Auto-join pre-step (gated by the default-off `autoJoin` setting inside
    // runJoinPass). Skipped for a single-challenge "Run" (challengeIdFilter set)
    // and never allowed to abort voting — a join failure is logged, not thrown.
    if (challengeIdFilter === null) {
        try {
            await runJoinPass(token, Date.now(), joinDeps);
        } catch (error) {
            logger
                .withCategory('join')
                .warning(`join pass errored (voting continues): ${error?.message || error}`, null);
        }
    }
    return runVotingPass(token, challengeIdFilter, {
        api: {
            getActiveChallenges,
            getVoteImages,
            submitVotes,
            applyBoost,
            applyBoostToEntry,
            applyTurbo,
            getEligiblePhotos,
            getImageData,
            submitToChallenge,
            runTurboMiniGame,
            // votingOrchestrator copies these into fillDeps; without them the
            // auto-fill path loses tag resolution in real mode only.
            getCurrentMemberProfile,
            searchTagAutocomplete,
        },
        cleanupStaleMetadata,
        // Real mode persists new-entry snapshots to metadata.json, where
        // cleanupStaleMetadata prunes them alongside their challenge.
        entryTracker: metadataEntryTracker,
        // Random 2-5s spacing between challenges to mimic human behavior.
        interChallengeDelay: () => getRandomDelay(2000, 5000),
    });
};

module.exports = {
    fetchChallengesAndVote,
    applyBoostToEntry,
    runTurboMiniGame,
    joinChallenge,
};
