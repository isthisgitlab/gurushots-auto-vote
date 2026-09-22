/**
 * Bankroll-currency actions on an entered challenge: spend a KEY to unlock a
 * locked boost, a SWAP to replace an entered photo, a FILL to top exposure up
 * to 100%.
 *
 * Every spend first re-reads the LIVE challenge and the LIVE bankroll and
 * re-checks the shared predicate (voting/currencyActions.js). That re-check is
 * also the idempotency guard: each spend is a single call whose effect is
 * visible in the challenge (boost AVAILABLE_KEY, entry replaced, exposure 100),
 * so a repeated request finds the state already changed and spends nothing —
 * unlike coinsUnlock's charge-then-join, which needs a persisted marker.
 *
 * Confirmation, the double-spend lock and argument validation live in the IPC
 * layer (ipc/actions.handlers.js); these functions assume the caller already
 * decided to spend.
 */

const { findActiveChallenge } = require('./findActiveChallenge');
const { rankCandidatesForChallenge, resolveMemberId } = require('./autoFill');
const { resetPassState: resetPhotoStatsPassState } = require('./photoStats');
const { CURRENCY_OUTCOME, blockedOutcome, swapExcludedIds } = require('../voting/currencyActions');

const nowSec = () => Math.floor(Date.now() / 1000);

const cat = (logger) => logger.withCategory('currency');

/**
 * Reads the live challenge and bankroll. A missing challenge is reported as
 * notAvailable; an unreadable bankroll is left null for blockedOutcome to map
 * onto balanceUnknown.
 */
const loadLive = async (challengeId, token, strategy) => {
    const [challengesResponse, bankroll] = await Promise.all([
        strategy.getActiveChallenges(token),
        strategy.getBankroll(token),
    ]);
    return { challenge: findActiveChallenge(challengesResponse?.challenges, challengeId), bankroll };
};

const entriesOf = (challenge) =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [];

const findEntry = (challenge, imageId) => entriesOf(challenge).find((entry) => String(entry?.id) === String(imageId));

const entryIds = (challenge) =>
    new Set(
        entriesOf(challenge)
            .map((entry) => entry?.id)
            .filter((id) => id !== undefined && id !== null && id !== '')
            .map(String),
    );

/**
 * Live re-check shared by every action. Returns the blocking outcome, or null
 * with the live challenge when the spend may go ahead.
 */
const checkLive = async (action, challengeId, token, strategy) => {
    const { challenge, bankroll } = await loadLive(challengeId, token, strategy);
    if (!challenge) return { blocked: CURRENCY_OUTCOME.notAvailable, challenge: null };
    return { blocked: blockedOutcome(action, challenge, bankroll, nowSec()), challenge };
};

const spendResult = (logger, label, challenge, result) => {
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
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {{strategy: object, logger: object}} deps
 * @returns {Promise<{ok: boolean, outcome: string}>}
 */
const unlockBoostWithKey = async (challengeId, token, { strategy, logger }) => {
    const { blocked, challenge } = await checkLive('key', challengeId, token, strategy);
    if (blocked) return { ok: false, outcome: blocked };
    return spendResult(logger, 'keyUnlock', challenge, await strategy.keyUnlock(challenge.id, token));
};

/**
 * Picks the photo a swap would put in place of `imageId` — the best-ranked
 * candidate under the same pipeline a fill uses, excluding every photo already
 * entered, every photo previously swapped out, and `imageId` itself. Spends
 * nothing.
 *
 * @param {string|number} challengeId
 * @param {string} imageId - the entered photo to replace
 * @param {string} token
 * @param {{strategy: object, logger: object, settings: object}} deps
 * @returns {Promise<{ok: boolean, outcome: string, candidate?: {id: string, member_id: string}}>}
 */
const previewSwap = async (challengeId, imageId, token, { strategy, logger, settings }) => {
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
            mustIncludeTags: settings?.getEffectiveTagSetting?.('mustIncludeTags', challenge) ?? null,
            shouldIncludeTags: settings?.getEffectiveTagSetting?.('shouldIncludeTags', challenge) ?? null,
            fillWithoutTagMatch: settings?.getEffectiveSetting?.('fillWithoutTagMatch', id),
        },
    );
    if (ranked.status !== 'ranked') {
        return { ok: false, outcome: CURRENCY_OUTCOME.apiFailed };
    }
    const best = ranked.picked[0];
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
 * is already entered / was swapped out before / equals `imageId`.
 *
 * @param {string|number} challengeId
 * @param {string} imageId
 * @param {string} newImageId
 * @param {string} token
 * @param {{strategy: object, logger: object}} deps
 * @returns {Promise<{ok: boolean, outcome: string}>}
 */
const swapEntry = async (challengeId, imageId, newImageId, token, { strategy, logger }) => {
    const { blocked, challenge } = await checkLive('swap', challengeId, token, strategy);
    if (blocked) return { ok: false, outcome: blocked };
    if (!entryIds(challenge).has(String(imageId))) {
        return { ok: false, outcome: CURRENCY_OUTCOME.notAvailable };
    }
    if (String(newImageId) === String(imageId) || swapExcludedIds(challenge).has(String(newImageId))) {
        return { ok: false, outcome: CURRENCY_OUTCOME.staleCandidate };
    }
    return spendResult(
        logger,
        'swap',
        challenge,
        await strategy.swapPhoto(challenge.id, String(imageId), String(newImageId), token),
    );
};

/**
 * Spends a FILL to top the challenge exposure up to 100%.
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {{strategy: object, logger: object}} deps
 * @returns {Promise<{ok: boolean, outcome: string}>}
 */
const fillExposure = async (challengeId, token, { strategy, logger }) => {
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

module.exports = { unlockBoostWithKey, previewSwap, swapEntry, fillExposure };
