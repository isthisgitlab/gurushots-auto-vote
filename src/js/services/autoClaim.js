/**
 * Automatic prize claiming — a pre-step in fetchChallengesAndVote, shared by the
 * real and mock strategies (the endpoints arrive via `deps`).
 *
 * Gated by the default-off `autoClaimPrizes` setting, and THROTTLED: the pass
 * runs at most once per CLAIM_INTERVAL_MS rather than every voting cycle.
 * Unclaimed prizes wait on the server for days, so an hourly sweep loses
 * nothing and keeps the extra list calls off the per-cycle hot path.
 *
 * The throttle clock is in memory: each process start claims on its first
 * cycle, then hourly. It is stamped BEFORE the calls, so a failing endpoint is
 * retried next interval instead of on every cycle. Claiming is safe to repeat —
 * only items the server reports as claimable (claim_state === 'CLAIM') are sent.
 */

import * as logger from '../logger';
import * as settings from '../settings';
import * as cancellation from '../voting/cancellation';

/**
 * @import { CompletedChallenge, Mission } from '../types/gurushots'
 */

/**
 * The endpoints the claim pass calls (api/rewards.ts, or the mock mirror).
 *
 * @typedef {object} ClaimDeps
 * @property {(token: string, start?: number, limit?: number) => Promise<CompletedChallenge[]>} getMyCompletedChallenges
 * @property {(challengeId: string|number, token: string) => Promise<boolean>} claimChallengeResources
 * @property {(token: string) => Promise<Mission[]>} getMyMissions
 * @property {(missionId: string|number, token: string) => Promise<boolean>} claimMissionPrize
 */

/**
 * One claimable item: a finished challenge or a mission.
 *
 * @typedef {{ id: string|number, name?: string, title?: string }} ClaimItem
 */

/** @typedef {{ kind: string, id: string|number, claimed: boolean }} ClaimResult */

const CLAIM_INTERVAL_MS = 60 * 60 * 1000;
const CLAIMABLE = 'CLAIM';
// get_my_completed_challenges page size (what the web app requests) and a cap
// on pages read per pass; unclaimed challenges sit at the newest end.
const COMPLETED_PAGE_SIZE = 20;
const MAX_COMPLETED_PAGES = 5;

let lastClaimAt = 0;

// Read the same clock that gates runClaimPass; zero means due on the first cycle.
const getAutoClaimStatus = () => ({
    enabled: settings.getEffectiveSetting('autoClaimPrizes', null) === true,
    nextClaimAt: lastClaimAt === 0 ? 0 : lastClaimAt + CLAIM_INTERVAL_MS,
});

const cat = () => logger.withCategory('claim');

/**
 * A challenge's reward resources carry `value`, a mission's prizes `amount`.
 *
 * @param {ReadonlyArray<{ type?: string, amount?: number, value?: number }> | null | undefined} prizes
 * @returns {string}
 */
const describePrizes = (prizes) =>
    (Array.isArray(prizes) ? prizes : []).map((p) => `${p?.amount ?? p?.value} ${p?.type}`).join(', ') ||
    'no listed prizes';

/**
 * @param {CompletedChallenge} challenge
 */
const challengePrizes = (challenge) =>
    challenge?.member?.rewards_by_section?.sections?.find((s) => s?.type === 'TOTAL')?.resources;

/**
 * Reads completed challenges page by page (stopping at a short page) and keeps
 * the claimable ones.
 *
 * @param {string} token
 * @param {ClaimDeps} deps
 * @returns {Promise<CompletedChallenge[]>}
 */
const listClaimableChallenges = async (token, deps) => {
    const claimable = [];
    for (let page = 0; page < MAX_COMPLETED_PAGES; page++) {
        const items = await deps.getMyCompletedChallenges(token, page * COMPLETED_PAGE_SIZE, COMPLETED_PAGE_SIZE);
        const list = Array.isArray(items) ? items : [];
        for (const challenge of list) {
            if (challenge?.member?.rewards_by_section?.claim_state === CLAIMABLE) claimable.push(challenge);
        }
        if (list.length < COMPLETED_PAGE_SIZE) break;
    }
    return claimable;
};

/**
 * Claims each item sequentially, stopping early on cancellation. A throw on one
 * item is logged and recorded; the rest are still attempted.
 *
 * @template {ClaimItem} T
 * @param {string} kind
 * @param {T[]} items
 * @param {(id: string|number) => Promise<boolean>} claim
 * @param {(item: T) => string} describe
 * @returns {Promise<ClaimResult[]>}
 */
const claimEach = async (kind, items, claim, describe) => {
    const results = [];
    for (const item of items) {
        if (cancellation.isCancelled()) {
            cat().warning('claim pass cancelled by user', null);
            break;
        }
        let claimed = false;
        try {
            claimed = (await claim(item.id)) === true;
        } catch (error) {
            cat().warning(
                `${kind} ${item.id} claim errored: ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message || error}`,
                null,
            );
        }
        if (claimed) {
            cat().success(`🎁 Claimed ${kind} "${item?.name ?? item?.title ?? item.id}": ${describe(item)}`, null);
        } else {
            cat().warning(`${kind} ${item.id} claim was not confirmed`, null);
        }
        results.push({ kind, id: item.id, claimed });
    }
    return results;
};

/**
 * Runs one half of the pass (challenges or missions) so a failure listing one
 * kind never blocks claiming the other.
 *
 * @template {ClaimItem} T
 * @param {string} kind
 * @param {() => Promise<T[]>} list
 * @param {(id: string|number) => Promise<boolean>} claim
 * @param {(item: T) => string} describe
 * @returns {Promise<ClaimResult[]>}
 */
const runHalf = async (kind, list, claim, describe) => {
    let items;
    try {
        items = await list();
    } catch (error) {
        cat().warning(
            `could not list claimable ${kind}s: ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message || error}`,
            null,
        );
        return [];
    }
    return claimEach(kind, items, claim, describe);
};

/**
 * @param {string} token
 * @param {number} now epoch ms — the throttle clock
 * @param {ClaimDeps} deps getMyCompletedChallenges / claimChallengeResources /
 *   getMyMissions / claimMissionPrize
 * @returns {Promise<{ran:boolean, challengesClaimed:number, missionsClaimed:number, results:ClaimResult[]}>}
 */
const runClaimPass = async (token, now, deps) => {
    const skipped = { ran: false, challengesClaimed: 0, missionsClaimed: 0, results: [] };
    if (!token || settings.getEffectiveSetting('autoClaimPrizes', null) !== true) return skipped;
    if (now - lastClaimAt < CLAIM_INTERVAL_MS) return skipped;
    lastClaimAt = now;

    const challengeResults = await runHalf(
        'challenge',
        () => listClaimableChallenges(token, deps),
        (id) => deps.claimChallengeResources(id, token),
        (challenge) => describePrizes(challengePrizes(challenge)),
    );
    const missionResults = await runHalf(
        'mission',
        async () => {
            const missions = await deps.getMyMissions(token);
            return (Array.isArray(missions) ? missions : []).filter((m) => m?.claim_state === CLAIMABLE);
        },
        (id) => deps.claimMissionPrize(id, token),
        (mission) => describePrizes(mission.prizes),
    );

    const results = [...challengeResults, ...missionResults];
    return {
        ran: true,
        challengesClaimed: challengeResults.filter((r) => r.claimed).length,
        missionsClaimed: missionResults.filter((r) => r.claimed).length,
        results,
    };
};

// Test hook: forget the throttle clock so each test starts from "never claimed".
const resetClaimThrottle = () => {
    lastClaimAt = 0;
};

export { CLAIM_INTERVAL_MS, getAutoClaimStatus, runClaimPass, resetClaimThrottle };
