/**
 * Bankroll-currency actions on an entered challenge: spend a KEY to unlock a
 * locked boost, a SWAP to replace an entered photo, a FILL to top exposure up
 * to 100%.
 *
 * Every spend first re-reads the LIVE challenge and the LIVE bankroll and
 * re-checks the shared predicate (voting/currencyActions.ts). That re-check is
 * also the idempotency guard: each spend is a single call whose effect is
 * visible in the challenge (boost AVAILABLE_KEY, entry replaced, exposure 100),
 * so a repeated request finds the state already changed and spends nothing —
 * unlike coinsUnlock's charge-then-join, which needs a persisted marker.
 *
 * Confirmation and argument validation live in the IPC layer
 * (ipc/currency.handlers.ts); these functions assume the caller already decided
 * to spend. The double-spend lock (withSpendLock) lives here so the manual
 * handlers and the automatic runners (services/currencyAuto.ts) share it.
 */

import { findActiveChallenge } from './findActiveChallenge';
import { rankCandidatesForChallenge, resolveMemberId } from './autoFill';
import { resetPassState as resetPhotoStatsPassState } from './photoStats';
import { CURRENCY_OUTCOME, blockedOutcome, swapExcludedIds } from '../voting/currencyActions';

import type { Challenge, RankingEntry } from '../types/gurushots';
import type * as loggerModule from '../logger';
import type * as settingsModule from '../settings';
import type * as swapBackStore from '../swapBackStore';
import type * as activeChallengesApi from '../strategies/real/activeChallenges';
import type * as joinApi from '../api/join';
import type * as currencyApi from '../api/currency';
import type * as submissionsApi from '../api/submissions';
import type * as tagsApi from '../api/tags';

type Logger = typeof loggerModule;
type SettingsFacade = typeof settingsModule;
export type SwapBackLedger = ReturnType<typeof swapBackStore.createLedger>;
export type CurrencyAction = 'key' | 'swap' | 'fill';

/**
 * The endpoints a spend reads off the strategy (the real or mock surface).
 */
export interface CurrencyStrategy {
    getActiveChallenges: typeof activeChallengesApi.getActiveChallenges;
    getBankroll: typeof joinApi.getBankroll;
    keyUnlock: typeof currencyApi.keyUnlock;
    swapPhoto: typeof currencyApi.swapPhoto;
    exposureAutofill: typeof currencyApi.exposureAutofill;
    getEligiblePhotos: typeof submissionsApi.getEligiblePhotos;
    getImageData: typeof submissionsApi.getImageData;
    searchTagAutocomplete: typeof tagsApi.searchTagAutocomplete;
    getCurrentMemberProfile: typeof tagsApi.getCurrentMemberProfile;
}

type CurrencyOutcome = (typeof CURRENCY_OUTCOME)[keyof typeof CURRENCY_OUTCOME];
export type SpendOutcome = { ok: boolean; outcome: string };
export type SwapCandidate = { id: string; member_id: string };

const nowSec = () => Math.floor(Date.now() / 1000);

// ONE lock across every spend — manual (all channels) and automatic alike: a
// single spend in flight at a time, so a click during a voting pass can't race
// the automation into spending twice. Released in `finally` so a throw can never
// wedge it.
let spendInFlight = false;

/**
 * Runs `spend` under the process-wide spend lock. Resolves {busy: true} without
 * calling it when another spend is in flight.
 */
const withSpendLock = async <T>(spend: () => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> => {
    if (spendInFlight) return { busy: true };
    spendInFlight = true;
    try {
        return { busy: false, value: await spend() };
    } finally {
        spendInFlight = false;
    }
};

const cat = (logger: Logger) => logger.withCategory('currency');

/**
 * Reads the live challenge and bankroll. A missing challenge is reported as
 * notAvailable; an unreadable bankroll is left null for blockedOutcome to map
 * onto balanceUnknown.
 */
const loadLive = async (challengeId: string | number, token: string, strategy: CurrencyStrategy) => {
    const [challengesResponse, bankroll] = await Promise.all([
        strategy.getActiveChallenges(token),
        strategy.getBankroll(token),
    ]);
    return { challenge: findActiveChallenge(challengesResponse?.challenges, challengeId), bankroll };
};

const entriesOf = (challenge: Challenge): RankingEntry[] =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [];

const findEntry = (challenge: Challenge, imageId: string | number) =>
    entriesOf(challenge).find((entry) => String(entry?.id) === String(imageId));

const entryIds = (challenge: Challenge) =>
    new Set(
        entriesOf(challenge)
            .map((entry) => entry?.id)
            .filter((id) => id !== undefined && id !== null && id !== '')
            .map(String),
    );

// Every photo swapped out of the challenge so far (the API's swap history).
const swappedOutIds = (challenge: Challenge) =>
    new Set(
        (Array.isArray(challenge?.member?.ranking?.swaps) ? challenge.member.ranking.swaps : []).map((s) =>
            String(s?.id),
        ),
    );

/**
 * Live re-check shared by every action. Returns the blocking outcome, or null
 * with the live challenge when the spend may go ahead.
 */
const checkLive = async (
    action: CurrencyAction,
    challengeId: string | number,
    token: string,
    strategy: CurrencyStrategy,
): Promise<
    { blocked: CurrencyOutcome; challenge: null } | { blocked: CurrencyOutcome | null; challenge: Challenge }
> => {
    const { challenge, bankroll } = await loadLive(challengeId, token, strategy);
    if (!challenge) return { blocked: CURRENCY_OUTCOME.notAvailable, challenge: null };
    // blockedOutcome only ever answers a CURRENCY_OUTCOME value or null.
    const blocked = blockedOutcome(action, challenge, bankroll, nowSec()) as CurrencyOutcome | null;
    return { blocked, challenge };
};

const spendResult = (
    logger: Logger,
    label: string,
    challenge: Challenge,
    result: { ok?: boolean } | null | undefined,
): SpendOutcome => {
    if (result?.ok) {
        cat(logger).info(`${label}: done for ${logger.challengeTag(challenge)}`, null);
        return { ok: true, outcome: CURRENCY_OUTCOME.ok };
    }
    cat(logger).warning(`${label}: rejected by the server for ${logger.challengeTag(challenge)}`, null);
    return { ok: false, outcome: CURRENCY_OUTCOME.apiFailed };
};

/**
 * Spends a KEY to unlock the challenge's LOCKED boost (unlock only — the boost
 * is not applied to any photo).
 */
const unlockBoostWithKey = async (
    challengeId: string | number,
    token: string,
    { strategy, logger }: { strategy: CurrencyStrategy; logger: Logger },
): Promise<SpendOutcome> => {
    const { blocked, challenge } = await checkLive('key', challengeId, token, strategy);
    if (blocked) return { ok: false, outcome: blocked };
    return spendResult(logger, 'keyUnlock', challenge, await strategy.keyUnlock(challenge.id, token));
};

/**
 * Picks the photo a swap would put in place of `imageId` — the best-ranked
 * candidate under the same pipeline a fill uses, excluding every photo already
 * entered and `imageId` itself. A photo swapped out earlier stays a candidate
 * unless `excludeSwapped` is set — the automatic swap sets it, since it means
 * "bring in a fresh photo" and would otherwise flip a slot between the photo it
 * just swapped out and its replacement. Spends nothing.
 *
 * @param imageId - the entered photo to replace
 */
const previewSwap = async (
    challengeId: string | number,
    imageId: string,
    token: string,
    { strategy, logger, settings }: { strategy: CurrencyStrategy; logger: Logger; settings: SettingsFacade },
    { excludeSwapped = false }: { excludeSwapped?: boolean } = {},
): Promise<{ ok: false; outcome: string } | { ok: true; outcome: string; candidate: SwapCandidate }> => {
    const { blocked, challenge } = await checkLive('swap', challengeId, token, strategy);
    if (blocked) return { ok: false, outcome: blocked };
    if (!entryIds(challenge).has(String(imageId))) {
        return { ok: false, outcome: CURRENCY_OUTCOME.notAvailable };
    }

    // A manual swap is its own operation, like a manual fill: fresh photo-stats
    // budget so an earlier pass's tripped breaker doesn't deny enrichment.
    resetPhotoStatsPassState();
    const id = String(challenge.id);
    const excludeIds = swapExcludedIds(challenge);
    excludeIds.add(String(imageId));
    if (excludeSwapped) {
        for (const swappedId of swappedOutIds(challenge)) excludeIds.add(swappedId);
    }
    const ranked = await rankCandidatesForChallenge(
        challenge,
        token,
        {
            settings,
            logger,
            getEligiblePhotos: strategy.getEligiblePhotos,
            getImageData: strategy.getImageData,
            searchTagAutocomplete: strategy.searchTagAutocomplete,
            getCurrentMemberProfile: strategy.getCurrentMemberProfile,
        },
        {
            label: 'swap',
            usage: 'swap',
            excludeIds,
            wantCount: 1,
            mustIncludeTags: settings.getEffectiveTagSetting('mustIncludeTags', challenge) ?? null,
            shouldIncludeTags: settings.getEffectiveTagSetting('shouldIncludeTags', challenge) ?? null,
            fillWithoutTagMatch: settings.getEffectiveSetting('fillWithoutTagMatch', id),
        },
    );
    if (ranked.status !== 'ranked') {
        return { ok: false, outcome: CURRENCY_OUTCOME.apiFailed };
    }
    // The pipeline's picks are library photo records (id, and usually member_id).
    const best = ranked.picked[0] as { id: string | number; member_id?: string } | undefined;
    if (!best) {
        cat(logger).info(`swap: no different photo available for ${logger.challengeTag(challenge)}`, null);
        return { ok: false, outcome: CURRENCY_OUTCOME.noAlternative };
    }
    return {
        ok: true,
        outcome: CURRENCY_OUTCOME.ok,
        // Library rows carry the owner's member_id; the replaced entry has the
        // same owner, which covers a row without it (the thumbnail needs it).
        candidate: {
            id: String(best.id),
            member_id: String(best.member_id ?? findEntry(challenge, imageId)?.member_id ?? ''),
        },
    };
};

/**
 * Spends a SWAP to replace entered photo `imageId` with `newImageId`. Refuses
 * (spending nothing) when `imageId` is no longer entered, or when `newImageId`
 * is already entered / equals `imageId`.
 *
 * @param deps - ledger: the swap-back
 *   ledger (swapBackStore.ts), told about every successful swap so a swapped-out
 *   boosted/turbo'd photo can be swapped back later
 */
const swapEntry = async (
    challengeId: string | number,
    imageId: string,
    newImageId: string,
    token: string,
    { strategy, logger, ledger = null }: { strategy: CurrencyStrategy; logger: Logger; ledger?: SwapBackLedger | null },
): Promise<SpendOutcome> => {
    const { blocked, challenge } = await checkLive('swap', challengeId, token, strategy);
    if (blocked) return { ok: false, outcome: blocked };
    if (!entryIds(challenge).has(String(imageId))) {
        return { ok: false, outcome: CURRENCY_OUTCOME.notAvailable };
    }
    if (String(newImageId) === String(imageId) || swapExcludedIds(challenge).has(String(newImageId))) {
        return { ok: false, outcome: CURRENCY_OUTCOME.staleCandidate };
    }
    const oldEntry = findEntry(challenge, imageId);
    const result = spendResult(
        logger,
        'swap',
        challenge,
        await strategy.swapPhoto(challenge.id, String(imageId), String(newImageId), token),
    );
    if (result.ok && ledger) ledger.onSwapped(challenge.id, oldEntry, newImageId);
    return result;
};

/**
 * Spends a SWAP to put a photo that was swapped out while boosted/turbo'd back
 * into the slot now holding `currentImageId` — the photo gets its boost/turbo
 * back. The original comes from the swap-back ledger, never from the caller,
 * and must still be in this challenge's swap history (not entered).
 *
 * @param currentImageId - the replacement now in the slot
 */
const swapBack = async (
    challengeId: string | number,
    currentImageId: string,
    token: string,
    { strategy, logger, ledger }: { strategy: CurrencyStrategy; logger: Logger; ledger: SwapBackLedger },
): Promise<SpendOutcome> => {
    const record = ledger.list(challengeId).find((r) => r.currentId === String(currentImageId));
    if (!record) return { ok: false, outcome: CURRENCY_OUTCOME.notAvailable };
    const { blocked, challenge } = await checkLive('swap', challengeId, token, strategy);
    if (blocked) return { ok: false, outcome: blocked };
    const history = swappedOutIds(challenge);
    const entered = entryIds(challenge);
    if (!entered.has(record.currentId) || entered.has(record.previousId) || !history.has(record.previousId)) {
        // The slot moved on outside this app — the record no longer describes it.
        ledger.remove(challengeId, record.currentId);
        return { ok: false, outcome: CURRENCY_OUTCOME.notAvailable };
    }
    const result = spendResult(
        logger,
        'swapBack',
        challenge,
        await strategy.swapPhoto(challenge.id, record.currentId, record.previousId, token),
    );
    if (result.ok) ledger.remove(challengeId, record.currentId);
    return result;
};

/**
 * Spends a FILL to top the challenge exposure up to 100%.
 */
const fillExposure = async (
    challengeId: string | number,
    token: string,
    { strategy, logger }: { strategy: CurrencyStrategy; logger: Logger },
): Promise<SpendOutcome> => {
    const { blocked, challenge } = await checkLive('fill', challengeId, token, strategy);
    if (blocked) return { ok: false, outcome: blocked };
    // The member id the endpoint wants is the profile id; every entry carries
    // the same id as member_id, which covers a failed profile lookup.
    const memberId =
        (await resolveMemberId(token, strategy.getCurrentMemberProfile, logger, 'currency')) ||
        entriesOf(challenge)[0]?.member_id ||
        null;
    if (!memberId) {
        cat(logger).warning(`fillExposure: member id unavailable for ${logger.challengeTag(challenge)}`, null);
        return { ok: false, outcome: CURRENCY_OUTCOME.apiFailed };
    }
    return spendResult(
        logger,
        'fillExposure',
        challenge,
        await strategy.exposureAutofill(challenge.id, String(memberId), token),
    );
};

export { withSpendLock, unlockBoostWithKey, previewSwap, swapEntry, swapBack, fillExposure };
