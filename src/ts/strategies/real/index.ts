/**
 * GuruShots Auto Voter - Real API strategy
 *
 * Composes the api/ endpoint wrappers with the shared services into the
 * real-mode strategy surface apiFactory exposes: the voting pass (with its
 * mission read and join and prize-claim pre-steps), manual join, the Turbo mini-game, and the
 * entry-picking boost and title-pinned challenge read. The mock counterpart
 * is mockApiClient in mock/index.ts.
 */

import { getActiveChallenges } from './activeChallenges';
import { applyBoost } from './applyBoost';
import { runSnapGame } from './snapGame';
import type { TurboGameOptions } from './snapGame';
import { getSuggestedPhotoIds } from './suggestedPhotos';
import { getVoteImages, submitVotes } from '../../api/voting';
import { applyBoostToEntry } from '../../api/boost';
import { getChallengeTurbo, submitTurboSelection, applyTurbo, TURBO_SELECTION_DELAY_MS } from '../../api/turbo';
import {
    getEligiblePhotos,
    getEligiblePhotosWalk,
    getImageData,
    submitToChallenge as submitToChallengeRaw,
} from '../../api/submissions';
import { getCurrentMemberProfile, searchTagAutocomplete } from '../../api/tags';
import { getMemberChallenges, getBankroll, coinsUnlock } from '../../api/join';
import { getMyCompletedChallenges, claimChallengeResources, getMyMissions, claimMissionPrize } from '../../api/rewards';
import { keyUnlock, swapPhoto as swapPhotoRaw, exposureAutofill } from '../../api/currency';
import { cleanupStaleMetadata } from '../../metadata';
import { swapBackLedger } from '../../swapBackStore';
import { autoSpendLedger } from '../../currencyAutoStore';
import { entryAgeLedger } from '../../entryAgeStore';
import { withEntryTimes } from '../../services/entryTimes';
import { CURRENCY_ENDPOINTS } from '../../services/currencyAuto';
import {
    scenarioStateLedger,
    scenarioStateLoaded,
    scenarioStepLock,
    refreshScenarioStateAsync,
} from '../../scenarioStateStore';
import { backgroundServiceOwnsScenarios } from '../../services/scenarioRunner';
import { sleep, getRandomDelay } from '../../timing';
import * as logger from '../../logger';
import * as settings from '../../settings';
import { runVotingPass } from '../../services/votingOrchestrator';
import { runSuspendBoosts } from '../../services/votingOrchestrator/suspendBoostRunner';
import { VOTING_PASS_ENDPOINTS } from '../../services/votingOrchestrator/context';
import { createMetadataEntryTracker } from '../../services/newEntryTracker';
import {
    runJoinPass,
    joinChallengeSingle,
    forgetUnconfirmedPayment as forgetPayment,
} from '../../services/joinChallenges';
import { JOIN_ENDPOINTS } from '../../services/joinChallenges/shared';
import { runClaimPass, CLAIM_ENDPOINTS } from '../../services/autoClaim';
import { loadMissionNeeds, registerMissionNeeds } from '../../services/missions';
import * as runtime from '../../runtime';
import { joinStateStore, acquireUnlockLock, refreshJoinStateAsync } from '../../joinStateStore';

import type { Challenge, TurboGameResult, TurboMiniGameResult } from '../../types/gurushots';
import { errorMessage } from '../../errorMessage';
import { pickEndpoints } from '../../pickEndpoints';

// The submit and swap every real caller goes through: a photo that went in is recorded at its exact time (the ledger
// the UI's "Submitted …" reads). Late-bound to the api module, so a replaced endpoint is the one that is called.
const { submitToChallenge, swapPhoto } = withEntryTimes(
    {
        submitToChallenge: (...args) => submitToChallengeRaw(...args),
        swapPhoto: (...args) => swapPhotoRaw(...args),
    },
    entryAgeLedger,
);

// One instance for the process: the tracker is stateless (it reads and writes
// metadata.json on each call), but building it per pass would be pointless churn.
const metadataEntryTracker = createMetadataEntryTracker();

/**
 * Manual single-challenge join (real strategy). Paid joins require an explicit
 * `spendCoins` — otherwise the call returns `needs-confirm` and spends nothing.
 */
const joinChallenge = (challengeId: string | number, spendCoins: boolean, token: string, expectedCost?: number) =>
    joinChallengeSingle(challengeId, token, joinDeps, {
        spendCoins: spendCoins === true,
        ...(expectedCost === undefined ? {} : { expectedCost }),
    });

/**
 * Plays one unresolved battle: picks first_image, and on a lost or errored
 * pick flips to second_image (after the selection delay). Resolves whether a
 * pick was correct, whether that took the flip, and whether the game is WON.
 *
 * @param battle - a battle with both image ids
 */
const playTurboBattle = async (
    challenge: Challenge,
    battle: { firstImageId: string; secondImageId: string },
    token: string,
): Promise<{ correct: boolean; flipped: boolean; won: boolean }> => {
    const first = await submitTurboSelection(challenge.id, battle.firstImageId, token);
    if (first.ok) {
        return { correct: true, flipped: false, won: first.state === 'WON' };
    }

    // First pick lost or errored — flip to the other image.
    await sleep(TURBO_SELECTION_DELAY_MS);
    const second = await submitTurboSelection(challenge.id, battle.secondImageId, token);
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
 */
const runTurboMiniGame = async (challenge: Challenge, token: string): Promise<TurboMiniGameResult> => {
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
        const { firstImageId, secondImageId } = battle;
        const outcome = await playTurboBattle(challenge, { firstImageId, secondImageId }, token);
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
 * Plays the turbo game of one challenge, whichever it is: the classic mini-game or Snap, by the mode the web read
 * reported. A challenge of unknown mode is never played (callers gate on it); asked anyway, nothing is sent.
 * Only the automatic run passes `isCancelled`; a manual run is never stopped by the voting-cancel flag.
 */
const runTurboGame = async (
    challenge: Challenge,
    token: string,
    options: TurboGameOptions = {},
): Promise<TurboGameResult> => {
    const mode = challenge.member?.turbo?.mode;
    if (mode === 'classic') return { kind: 'classic', ...(await runTurboMiniGame(challenge, token)) };
    if (mode === 'snap') return { kind: 'snap', ...(await runSnapGame(challenge, token, options)) };
    logger.withCategory('turbo').warning(`${logger.challengeTag(challenge)} Turbo mode unknown; no game played`, null);
    return { kind: 'classic', played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false };
};

/**
 * Every endpoint the four bundles below project from, as the api/* modules
 * (and the entry-time-recording submit and swap) export them right now.
 * votingPassApi reads it per call so jest.mock'd api modules take effect; the
 * join, currency and claim bundles are module-level consts and project once
 * at load.
 */
const realClient = () => ({
    getActiveChallenges,
    getVoteImages,
    submitVotes,
    applyBoost,
    applyBoostToEntry,
    applyTurbo,
    getEligiblePhotos,
    getEligiblePhotosWalk,
    getImageData,
    submitToChallenge,
    runTurboGame,
    getCurrentMemberProfile,
    searchTagAutocomplete,
    getMemberChallenges,
    getBankroll,
    coinsUnlock,
    getSuggestedPhotoIds,
    keyUnlock,
    swapPhoto,
    exposureAutofill,
    getMyCompletedChallenges,
    claimChallengeResources,
    getMyMissions,
    claimMissionPrize,
});

// Deps bundle shared by the automatic join pass and the manual single-join path.
// joinStateStore persists the paid-unlock markers; acquireUnlockLock guards the
// unlock critical section across processes (real strategy only — mock passes a
// null store and no lock).
const joinDeps = {
    ...pickEndpoints(realClient(), JOIN_ENDPOINTS),
    joinStateStore,
    acquireUnlockLock,
    refreshJoinState: refreshJoinStateAsync,
};

// Endpoints the automatic currency spends use (services/currencyAuto.ts) — the
// same surface services/currencyActions.ts reads off the strategy for a manual
// spend, plus getVoteImages for the exposure-fill shortfall check.
const currencyStrategy = pickEndpoints(realClient(), CURRENCY_ENDPOINTS);

// Endpoints for the hourly prize-claim pre-step (services/autoClaim.ts).
const claimDeps = pickEndpoints(realClient(), CLAIM_ENDPOINTS);

/**
 * The user forgetting a claim whose payment could not be confirmed (real strategy): the next join asks the price again.
 */
const forgetUnconfirmedPayment = (challengeId: string | number, token: string) =>
    forgetPayment(challengeId, token, joinDeps);

/**
 * The endpoints runVotingPass reads off `deps.api`. Read per call (not at module
 * load) so jest.mock'd api modules take effect.
 */
const votingPassApi = () => pickEndpoints(realClient(), VOTING_PASS_ENDPOINTS);

/**
 * Apply the boosts of the given challenges now, over the same endpoints and
 * entry-age ledger a voting pass uses (device going to sleep —
 * windows/suspendBoost.ts). Thin binder over the shared runSuspendBoosts.
 */
const applyBoostsOnSuspend = (challenges: readonly Challenge[], token: string, now?: number) =>
    runSuspendBoosts(challenges, token, { api: votingPassApi(), entryAges: entryAgeLedger }, now);

// Whether a setting the window leaves to the background service is on (the global default; a challenge's own rule may
// turn it on too); it is said once a process, so that a vote started in the app that does not join or fill has a
// reason in the log without repeating it every run.
let saidLeftToService = false;
const leftToServiceIsOn = (): boolean =>
    settings.getSetting('autoJoin') === true ||
    settings.getSetting('autoExposureFill') === true ||
    settings.getSetting('missionUseFills') === true;

/**
 * Main function that fetches active challenges and processes them — thin
 * binder over the shared orchestration (services/votingOrchestrator.ts),
 * which real and mock strategies both run. The endpoint references are
 * passed per call (not at module load) so jest.mock'd api modules take
 * effect.
 *
 * @param token - Authentication token
 * @param challengeIdFilter - When set, restricts the strategy pass to a single challenge (per-card "Run"). Stale-metadata cleanup still runs against the full active list before filtering.
 *   `challenges` is the *full* active list this cycle fetched (not the per-challenge
 *   filtered subset), so callers can reuse it for threshold scheduling instead of
 *   re-fetching. Absent only when the fetch itself threw before a list was obtained.
 */
const fetchChallengesAndVote = async (
    token: string,
    challengeIdFilter: string | number | null = null,
): Promise<{ success: boolean; message?: string; error?: string; challenges?: Challenge[] }> => {
    // What the active missions still need — read only while a mission setting is
    // on, shared by the join pre-step and the pass, which count it down.
    const missions = await loadMissionNeeds(token, Date.now(), { getMyMissions });
    const unregisterMissionNeeds = registerMissionNeeds(token, missions);
    try {
        // Auto-join pre-step (gated by the default-off `autoJoin` setting inside
        // runJoinPass). Skipped for a single-challenge "Run" (challengeIdFilter set)
        // and never allowed to abort voting — a join failure is logged, not thrown.
        if (!saidLeftToService && backgroundServiceOwnsScenarios() && leftToServiceIsOn()) {
            saidLeftToService = true;
            logger
                .withCategory('voting')
                .info(
                    'auto-join and automatic fills are left to the background service on Android; they run while auto-vote is on',
                );
        }
        if (challengeIdFilter === null) {
            // With the background service the window leaves the automatic joins to it: two loops paying from one
            // claims file would overwrite each other's unlock markers.
            if (!backgroundServiceOwnsScenarios()) {
                try {
                    await runJoinPass(token, Date.now(), joinDeps, missions);
                } catch (error) {
                    logger
                        .withCategory('join')
                        .warning(`join pass errored (voting continues): ${errorMessage(error) || error}`, null);
                }
            }
            // Prize-claim pre-step: gated by the default-off `autoClaimPrizes`
            // setting and throttled to once an hour inside runClaimPass.
            try {
                await runClaimPass(token, Date.now(), claimDeps);
            } catch (error) {
                logger
                    .withCategory('claim')
                    .warning(`claim pass errored (voting continues): ${errorMessage(error) || error}`, null);
            }
        }
        // The Android background service advances scenarios in its own JS context;
        // re-read its state so this pass's phase-settings overlay is current. Also while the app's cache of it was
        // never filled (a start-up read failed): until it is, plans stay paused.
        if (backgroundServiceOwnsScenarios() || !scenarioStateLoaded()) await refreshScenarioStateAsync();
        return await runVotingPass(token, challengeIdFilter, {
            api: votingPassApi(),
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
                // The service counts the automatic fills against autoExposureFillMax, in the same stored ledger, and
                // a mission's fills down on its own: two loops would overwrite and overspend, so the window leaves
                // fills to it.
                fillsLeftToService: backgroundServiceOwnsScenarios(),
            },
            // User-defined scenarios over the persisted state ledger. In the Android
            // app WebView the native background service owns them (it runs a pass
            // alongside the in-app loop, with its own copy of the state), so only
            // one loop ever advances a challenge's plan.
            scenarios: {
                ledger: scenarioStateLedger,
                enabled: () => !backgroundServiceOwnsScenarios(),
                lock: scenarioStepLock,
            },
            missions,
            refreshMissionNeeds: runtime.isHeadlessService()
                ? () => loadMissionNeeds(token, Date.now(), { getMyMissions })
                : null,
        });
    } finally {
        unregisterMissionNeeds?.();
    }
};

export {
    fetchChallengesAndVote,
    applyBoostsOnSuspend,
    getActiveChallenges,
    applyBoost,
    runTurboGame,
    joinChallenge,
    forgetUnconfirmedPayment,
    submitToChallenge,
    swapPhoto,
    getSuggestedPhotoIds,
};
