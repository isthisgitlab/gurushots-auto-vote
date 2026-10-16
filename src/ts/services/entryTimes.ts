/**
 * When each entry went into its challenge, recorded and shown. The API reports no per-entry submit time, so the
 * app's entry-age ledger (entryAgeStore) keeps one: the exact time of every photo the app submits or swaps in
 * (`withEntryTimes`), and for photos submitted elsewhere the time a challenge fetch first showed them
 * (`annotateEntryTimes`, which puts the answer on each entry as `appEntered` for the UI).
 *
 * Bookkeeping never changes a result: a ledger failure is logged (the message only — the ledger holds image and
 * member ids) and the API result, or the fetched response, is returned as it was, so it can never turn a submit or
 * swap that landed (a spend, sent once) or a good fetch into a failure.
 */

import * as logger from '../logger';
import { errorMessage } from '../errorMessage';
import type { submitToChallenge as SubmitToChallenge } from '../api/submissions';
import type { swapPhoto as SwapPhoto } from '../api/currency';
import type { ActiveChallengesResponse, Challenge, RankingEntry } from '../types/gurushots';
import type { EntryAgeLedger } from '../types/stores';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const entriesOf = (challenge: Challenge): RankingEntry[] =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries : [];

const logFailure = (what: string, error: unknown) => {
    logger.withCategory('boost').warning(`${what}: ${errorMessage(error) ?? String(error)}`, null);
};

/**
 * Sets `appEntered` on every entry of a fetched response: the time the ledger has for it, exact for a photo the app
 * submitted, else the first fetch that showed it. The field is the app's own: whatever the server sent under that name
 * is deleted first, even when the ledger fails. A failed fetch is left alone.
 *
 * @param now - Unix seconds
 */
export const annotateEntryTimes = async (
    response: ActiveChallengesResponse,
    ledger: EntryAgeLedger,
    now: number = nowSeconds(),
): Promise<void> => {
    if (response.fetchFailed || !Array.isArray(response.challenges)) return;
    for (const challenge of response.challenges) {
        for (const entry of entriesOf(challenge)) delete entry?.appEntered;
    }
    try {
        // The background service records entries in its own context: see what it wrote.
        await ledger.refresh();
        const times = ledger.observeAll(response.challenges, now);
        for (const challenge of response.challenges) {
            for (const entry of entriesOf(challenge)) {
                const time = times[String(challenge.id)]?.[String(entry?.id)];
                if (time) entry.appEntered = { at: time.at, exact: time.exact };
            }
        }
    } catch (error) {
        logFailure('entry times not recorded', error);
    }
};

/**
 * `submitToChallenge` and `swapPhoto` that record the exact time of a photo that went in: after a result that is `ok`
 * (an unclear or failed one is not marked), the photos submitted, or the one swapped in. The result is returned
 * unchanged.
 */
export const withEntryTimes = (
    api: { submitToChallenge: typeof SubmitToChallenge; swapPhoto: typeof SwapPhoto },
    ledger: EntryAgeLedger,
): { submitToChallenge: typeof SubmitToChallenge; swapPhoto: typeof SwapPhoto } => {
    const mark = (challengeId: string | number, imageIds: string[]) => {
        try {
            ledger.markSubmitted(challengeId, imageIds, nowSeconds());
        } catch (error) {
            logFailure('submit time not recorded', error);
        }
    };
    return {
        submitToChallenge: async (challengeId, imageIds, token) => {
            const result = await api.submitToChallenge(challengeId, imageIds, token);
            if (result.ok) mark(challengeId, imageIds);
            return result;
        },
        swapPhoto: async (challengeId, oldImageId, newImageId, token) => {
            const result = await api.swapPhoto(challengeId, oldImageId, newImageId, token);
            if (result.ok) mark(challengeId, [newImageId]);
            return result;
        },
    };
};
