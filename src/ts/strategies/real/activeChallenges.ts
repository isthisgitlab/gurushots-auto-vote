/**
 * Real-strategy active-challenge read: the api/challenges fetch plus
 * first-seen title pinning, with concurrent calls coalesced per token.
 */

import { fetchActiveChallenges, fetchWebActiveTurbos } from '../../api/challenges';
import { pinChallengeTitles } from '../../services/challengeTitlePin';
import { annotateEntryTimes } from '../../services/entryTimes';
import { entryAgeLedger } from '../../entryAgeStore';
import { snapLedger } from '../../snapChallengeStore';
import type { ListedChallenge } from '../../snapChallengeStore';
import * as logger from '../../logger';
import { isKnownTurboMode } from '../../voting/turboMode';

import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';

/**
 * A challenge seen as Snap stays Snap (snapChallengeStore): the ones the web read reports as Snap are recorded, and a
 * recorded one the read now reports as classic (GuruShots does after a Snap is withdrawn, after a dead session and
 * for the game after a won Snap) is put back at 'snap', its state and timer as reported. Only the Snap runner ever
 * plays it, and it marks the challenge unavailable once GuruShots no longer offers Snap, so a Snap turbo is never
 * earned as classic. While the record cannot be read, no classic turbo that can still be earned is left playable
 * (its mode is dropped, like one the web read did not cover); a won one keeps its mode, so it can still be applied.
 * The record keeps each id's close_time current and forgets an id an hour after its challenge closed
 * (snapChallengeStore); a challenge missing from this read is kept.
 */
const keepSnapMode = async (challenges: Challenge[]): Promise<void> => {
    const recorded = await snapLedger.read();
    const listing: ListedChallenge[] = [];
    for (const challenge of challenges) {
        const turbo = challenge.member?.turbo;
        const id = String(challenge.id);
        listing.push({ id, closeTime: Number(challenge.close_time), snap: turbo?.mode === 'snap' });
        if (!turbo || turbo.mode === 'snap') continue;
        if (isKnownTurboMode(turbo)) {
            if (recorded === null) {
                if (turbo.state !== 'WON') turbo.mode = undefined;
            } else if (recorded.has(id)) {
                turbo.mode = 'snap';
                logger.withCategory('turbo').debug(`${logger.challengeTag(challenge)} Turbo kept as Snap`, null);
            }
        }
    }
    await snapLedger.record(listing);
};

/**
 * Two reads, started together: the mobile active-challenges list and the web
 * one (its turbo is the only one with a `mode`; the mobile one has none, and a
 * wrong state for a Snap turbo). Each challenge's turbo is taken from the web
 * read when it covers that challenge and the mobile read succeeded; otherwise
 * the mobile turbo (no `mode`) stays. First-seen titles are pinned onto a
 * successful response and the time each entry went in is put on it
 * (services/entryTimes). A turbo ever reported as Snap stays Snap (keepSnapMode). A failed mobile
 * fetch (flagged `fetchFailed`) must never reach the pin/prune logic — a
 * network blip would wipe pins. The server mutates `title` while an event
 * (turbo) is active; pinning keeps display and title-rule matching stable
 * (see services/challengeTitlePin).
 */
const fetchAndPin = async (token: string): Promise<ActiveChallengesResponse> => {
    // Both requests are in flight before either is awaited; fetchWebActiveTurbos never rejects.
    const mobileRead = fetchActiveChallenges(token);
    const webRead = fetchWebActiveTurbos(token);
    const response = await mobileRead;
    if (!response.fetchFailed && Array.isArray(response.challenges)) {
        const webTurbos = await webRead;
        for (const challenge of response.challenges) {
            const turbo = webTurbos?.get(String(challenge.id));
            if (turbo && challenge.member) {
                challenge.member.turbo = turbo;
            }
        }
        await keepSnapMode(response.challenges);
        pinChallengeTitles(response.challenges);
        await annotateEntryTimes(response, entryAgeLedger);
    }
    return response;
};

// In-flight request coalescing. Independent consumers can want the current
// active-challenge list at the same instant — e.g. a UI challenges refresh
// racing an in-progress voting cycle. We share the in-flight promise per token
// and clear it as soon as the request settles, so only genuinely *concurrent*
// calls are merged (and pinned once); a later (sequential) call still hits the
// network for fresh data. No resolved-result caching, so this never serves
// stale challenge state.
const inFlightByToken: Map<string, Promise<ActiveChallengesResponse>> = new Map();

/**
 * Fetches all active challenges for the authenticated user, coalescing
 * concurrent calls for the same token into one request.
 *
 * @param token - Authentication token
 * @returns Response containing array of active challenges
 *                   or empty challenges array if request fails
 */
const getActiveChallenges = (token: string): Promise<ActiveChallengesResponse> => {
    const key = token || '';
    const existing = inFlightByToken.get(key);
    if (existing) {
        return existing;
    }

    const request = fetchAndPin(token).finally(() => {
        inFlightByToken.delete(key);
    });
    inFlightByToken.set(key, request);
    return request;
};

export { getActiveChallenges };
