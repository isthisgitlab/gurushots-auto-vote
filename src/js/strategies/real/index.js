/**
 * GuruShots Auto Voter - Real API strategy
 *
 * Composes the api/ endpoint wrappers with the shared services into the
 * real-mode strategy surface apiFactory exposes: the voting pass (with its
 * join and prize-claim pre-steps), manual join, the Turbo mini-game, and the
 * entry-picking boost and title-pinned challenge read. The mock counterpart
 * is mockApiClient in mock/index.js.
 */

import { getActiveChallenges } from './activeChallenges';
import { applyBoost } from './applyBoost';
import { getVoteImages, submitVotes } from '../../api/voting';
import { applyBoostToEntry } from '../../api/boost';
import { getChallengeTurbo, submitTurboSelection, applyTurbo, TURBO_SELECTION_DELAY_MS } from '../../api/turbo';
import { getEligiblePhotos, getImageData, submitToChallenge } from '../../api/submissions';
import { getCurrentMemberProfile, searchTagAutocomplete } from '../../api/tags';
import { getMemberChallenges, getBankroll, coinsUnlock } from '../../api/join';
import { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize } from '../../api/rewards';
import { keyUnlock, swapPhoto, exposureAutofill } from '../../api/currency';
import { cleanupStaleMetadata } from '../../metadata';
import { swapBackLedger } from '../../swapBackStore';
import { autoSpendLedger } from '../../currencyAutoStore';
import { entryAgeLedger } from '../../entryAgeStore';
import { scenarioStateLedger, refreshScenarioStateAsync } from '../../scenarioStateStore';
import { backgroundServiceOwnsScenarios } from '../../services/scenarioRunner';
import { sleep, getRandomDelay } from '../../timing';
import * as logger from '../../logger';
import { runVotingPass } from '../../services/votingOrchestrator';
import { createMetadataEntryTracker } from '../../services/newEntryTracker';
import { runJoinPass, joinChallengeSingle } from '../../services/joinChallenges';
import { runClaimPass } from '../../services/autoClaim';
import { joinStateStore, acquireUnlockLock } from '../../joinStateStore';

/** @import { Challenge, TurboBattle, TurboMiniGameResult } from '../../types/gurushots' */

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

// Endpoints the automatic currency spends use (services/currencyAuto.js) — the
// same surface services/currencyActions.js reads off the strategy for a manual
// spend, plus getVoteImages for the exposure-fill shortfall check.
const currencyStrategy = {
    getActiveChallenges,
    getBankroll,
    keyUnlock,
    swapPhoto,
    exposureAutofill,
    getVoteImages,
    getEligiblePhotos,
    getImageData,
    searchTagAutocomplete,
    getCurrentMemberProfile,
};

// Endpoints for the hourly prize-claim pre-step (services/autoClaim.js).
const claimDeps = {
    getMyCompletedChallenges,
    claimChallengeResources,
    getMyMissions,
    claimMissionPrize,
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
 * Plays one unresolved battle: picks first_image, and on a lost or errored
 * pick flips to second_image (after the selection delay). Resolves whether a
 * pick was correct, whether that took the flip, and whether the game is WON.
 *
 * @param {Challenge} challenge
 * @param {TurboBattle} battle
 * @param {string} token
 * @returns {Promise<{correct: boolean, flipped: boolean, won: boolean}>}
 */
const playTurboBattle = async (challenge, battle, token) => {
    // runTurboMiniGame only plays a battle whose two image ids are both present.
    const first = await submitTurboSelection(challenge.id, /** @type {string} */ (battle.firstImageId), token);
    if (first.ok) {
        return { correct: true, flipped: false, won: first.state === 'WON' };
    }

    // First pick lost or errored — flip to the other image.
    await sleep(TURBO_SELECTION_DELAY_MS);
    const second = await submitTurboSelection(challenge.id, /** @type {string} */ (battle.secondImageId), token);
    if (!second.ok) {
        const code = second.errorCode || first.errorCode;
        if (code) {
            logger
                .withCategory('turbo')
                .warning(`${logger.challengeTag(challenge)} Turbo battle skipped, error_code=${code}`, null);
        }
    }
    return { correct: !!second.ok, flipped: !!second.ok, won: !!second.ok && second.state === 'WON' };
};

/**
 * Plays through the Turbo mini-game for a single challenge.
 * Iterates pair-by-pair (see playTurboBattle), skipping resolved battles and
 * counting malformed ones as double failures, and stops early once a response
 * reports state === 'WON'.
 *
 * @param {Challenge} challenge
 * @param {string} token
 * @returns {Promise<TurboMiniGameResult>}
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
        const outcome = await playTurboBattle(challenge, battle, token);
        if (outcome.correct) correct++;
        else doubleFailed++;
        if (outcome.flipped) flipped++;
        if (outcome.won) {
            won = true;
            break;
        }
        await sleep(TURBO_SELECTION_DELAY_MS);
    }

    return { played, correct, flipped, doubleFailed, won };
};

/**
 * Main function that fetches active challenges and processes them — thin
 * binder over the shared orchestration (services/votingOrchestrator.js),
 * which real and mock strategies both run. The endpoint references are
 * passed per call (not at module load) so jest.mock'd api modules take
 * effect.
 *
 * @param {string} token - Authentication token
 * @param {string|number|null} [challengeIdFilter] - When set, restricts the strategy pass to a single challenge (per-card "Run"). Stale-metadata cleanup still runs against the full active list before filtering.
 * @returns {Promise<{success:boolean, message?:string, error?:string, challenges?:Challenge[]}>}
 *   `challenges` is the *full* active list this cycle fetched (not the per-challenge
 *   filtered subset), so callers can reuse it for threshold scheduling instead of
 *   re-fetching. Absent only when the fetch itself threw before a list was obtained.
 */
const fetchChallengesAndVote = async (token, challengeIdFilter = null) => {
    // Auto-join pre-step (gated by the default-off `autoJoin` setting inside
    // runJoinPass). Skipped for a single-challenge "Run" (challengeIdFilter set)
    // and never allowed to abort voting — a join failure is logged, not thrown.
    if (challengeIdFilter === null) {
        try {
            await runJoinPass(token, Date.now(), joinDeps);
        } catch (error) {
            logger
                .withCategory('join')
                .warning(
                    `join pass errored (voting continues): ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message || error}`,
                    null,
                );
        }
        // Prize-claim pre-step: gated by the default-off `autoClaimPrizes`
        // setting and throttled to once an hour inside runClaimPass.
        try {
            await runClaimPass(token, Date.now(), claimDeps);
        } catch (error) {
            logger
                .withCategory('claim')
                .warning(
                    `claim pass errored (voting continues): ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message || error}`,
                    null,
                );
        }
    }
    // The Android background service advances scenarios in its own JS context;
    // re-read its state so this pass's phase-settings overlay is current.
    if (backgroundServiceOwnsScenarios()) await refreshScenarioStateAsync();
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
        // When each entry entered its challenge, for the boost's fresh-entry wait.
        entryAges: entryAgeLedger,
        // Random 2-5s spacing between challenges to mimic human behavior.
        interChallengeDelay: () => getRandomDelay(2000, 5000),
        // Automatic key / swap / fill spends; the ledgers are the persisted ones
        // the manual currency handlers use too.
        currency: {
            strategy: currencyStrategy,
            swapLedger: swapBackLedger,
            spendLedger: autoSpendLedger,
        },
        // User-defined scenarios over the persisted state ledger. In the Android
        // app WebView the native background service owns them (it runs a pass
        // alongside the in-app loop, with its own copy of the state), so only
        // one loop ever advances a challenge's plan.
        scenarios: { ledger: scenarioStateLedger, enabled: () => !backgroundServiceOwnsScenarios() },
    });
};

export { fetchChallengesAndVote, getActiveChallenges, applyBoost, runTurboMiniGame, joinChallenge };
