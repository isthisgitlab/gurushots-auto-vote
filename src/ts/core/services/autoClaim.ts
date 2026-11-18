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

import type { CompletedChallenge, Mission } from '../types/gurushots';
import { errorMessage } from '../errorMessage';

/**
 * The endpoints the claim pass calls (api/rewards.ts, or the mock mirror).
 */
interface ClaimDeps {
    getMyCompletedChallenges: (token: string, start?: number, limit?: number) => Promise<CompletedChallenge[] | null>;
    claimChallengeResources: (challengeId: string | number, token: string) => Promise<boolean>;
    getMyMissions: (token: string) => Promise<Mission[] | null>;
    claimMissionPrize: (missionId: string | number, token: string) => Promise<boolean>;
}

/**
 * The endpoint names `ClaimDeps` carries; both strategies project them from
 * this one list (pickEndpoints).
 */
export const CLAIM_ENDPOINTS = [
    'getMyCompletedChallenges',
    'claimChallengeResources',
    'getMyMissions',
    'claimMissionPrize',
] as const;

/**
 * One claimable item: a finished challenge or a mission.
 */
type ClaimItem = { id: string | number; name?: string; title?: string };

type ClaimResult = { kind: string; id: string | number; claimed: boolean };

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
 */
const describePrizes = (
    prizes: ReadonlyArray<{ type?: string; amount?: number; value?: number }> | null | undefined,
): string =>
    (Array.isArray(prizes) ? prizes : []).map((p) => `${p?.amount ?? p?.value} ${p?.type}`).join(', ') ||
    'no listed prizes';

const challengePrizes = (challenge: CompletedChallenge) =>
    challenge?.member?.rewards_by_section?.sections?.find((s) => s?.type === 'TOTAL')?.resources;

/**
 * Whether a finished challenge's rewards wait to be claimed (the server says `claim_state` is CLAIM).
 */
const isClaimable = (challenge: CompletedChallenge): boolean =>
    challenge?.member?.rewards_by_section?.claim_state === CLAIMABLE;

/**
 * Reads the completed challenges page by page, stopping at a short page or at the page cap. `complete`: the listing
 * reached its end. `failedPage` (1-based): a page that was not read, which ends the listing there; what the earlier pages
 * held is returned all the same.
 */
const readCompletedChallenges = async (
    token: string,
    deps: Pick<ClaimDeps, 'getMyCompletedChallenges'>,
): Promise<{ challenges: CompletedChallenge[]; complete: boolean; failedPage: number | null }> => {
    const challenges: CompletedChallenge[] = [];
    for (let page = 0; page < MAX_COMPLETED_PAGES; page++) {
        const items = await deps.getMyCompletedChallenges(token, page * COMPLETED_PAGE_SIZE, COMPLETED_PAGE_SIZE);
        if (!Array.isArray(items)) return { challenges, complete: false, failedPage: page + 1 };
        challenges.push(...items);
        if (items.length < COMPLETED_PAGE_SIZE) return { challenges, complete: true, failedPage: null };
    }
    return { challenges, complete: false, failedPage: null };
};

/**
 * Reads completed challenges page by page (stopping at a short page) and keeps
 * the claimable ones. A page that was not read is logged, and the ones read before it are still claimed.
 */
const listClaimableChallenges = async (token: string, deps: ClaimDeps): Promise<CompletedChallenge[]> => {
    const { challenges, failedPage } = await readCompletedChallenges(token, deps);
    if (failedPage !== null) {
        cat().warning(`could not read completed challenges (page ${failedPage}); claiming what was read`, null);
    }
    return challenges.filter(isClaimable);
};

/**
 * Claims each item sequentially, stopping early on cancellation. A throw on one
 * item is logged and recorded; the rest are still attempted.
 */
const claimEach = async <T extends ClaimItem>(
    kind: string,
    items: T[],
    claim: (id: string | number) => Promise<boolean>,
    describe: (item: T) => string,
): Promise<ClaimResult[]> => {
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
            cat().warning(`${kind} ${item.id} claim errored: ${errorMessage(error) || error}`, null);
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
 */
const runHalf = async <T extends ClaimItem>(
    kind: string,
    list: () => Promise<T[]>,
    claim: (id: string | number) => Promise<boolean>,
    describe: (item: T) => string,
): Promise<ClaimResult[]> => {
    let items;
    try {
        items = await list();
    } catch (error) {
        cat().warning(`could not list claimable ${kind}s: ${errorMessage(error) || error}`, null);
        return [];
    }
    return claimEach(kind, items, claim, describe);
};

/**
 * @param now epoch ms — the throttle clock
 * @param deps getMyCompletedChallenges / claimChallengeResources /
 *   getMyMissions / claimMissionPrize
 */
const runClaimPass = async (
    token: string,
    now: number,
    deps: ClaimDeps,
): Promise<{ ran: boolean; challengesClaimed: number; missionsClaimed: number; results: ClaimResult[] }> => {
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
            if (!Array.isArray(missions)) {
                cat().warning('could not read missions; nothing claimed from them this time', null);
                return [];
            }
            return missions.filter((m) => m?.claim_state === CLAIMABLE);
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

export {
    CLAIM_INTERVAL_MS,
    getAutoClaimStatus,
    runClaimPass,
    resetClaimThrottle,
    readCompletedChallenges,
    isClaimable,
};
