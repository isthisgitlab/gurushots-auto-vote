/**
 * Real-strategy active-challenge read: the api/challenges fetch plus
 * first-seen title pinning, with concurrent calls coalesced per token.
 */

import { fetchActiveChallenges, fetchWebActiveOverlay } from '../../api/challenges';
import { pinChallengeTitles } from '../../services/challengeTitlePin';
import { annotateEntryTimes } from '../../services/entryTimes';
import { entryAgeLedger } from '../../entryAgeStore';
import { refreshTeamMatch, settledTeamMatch } from './teamMatch';
import { beginSuggestedPhotos, storeSuggestedPhotos } from './suggestedPhotos';
import { isMarkedChallenge } from '../../challengeMarks';
import { isPlainObject } from '../../plainObject';
import * as logger from '../../logger';

import type { ActiveChallengesResponse } from '../../types/gurushots';

const TEAM_MATCH_WAIT_MS = 2000;

/**
 * Two reads, started together: the mobile active-challenges list and the web
 * one (its turbo is the only one with a `mode`; the mobile one has none, and a
 * wrong state for a Snap turbo). When the mobile read succeeded, each
 * challenge's web overlay lands on it: the turbo when it covers that challenge
 * and the challenge has a member, and the overlay fields (benchmark,
 * first_prizes, achievements_and_prizes, the rank flags) whenever it covers
 * the challenge at all — the benchmark merged into `member.ranking.total`
 * without touching the mobile read's own fields. The web read's per-entry
 * Guru's picks raise `guru_pick` on the mobile entries whose id matches (only
 * raises; a failed web read leaves the mobile flags as they are). A failed
 * mobile fetch (flagged `fetchFailed`) must never reach the pin/prune logic —
 * a network blip would wipe pins. The server mutates `title` while an event
 * (turbo) is active; pinning keeps display and title-rule matching stable (see
 * services/challengeTitlePin).
 */
const fetchAndPin = async (token: string): Promise<ActiveChallengesResponse> => {
    // Both requests are in flight before either is awaited; fetchWebActiveOverlay never rejects.
    const mobileRead = fetchActiveChallenges(token);
    const webRead = fetchWebActiveOverlay(token);
    // The team match refreshes alongside the reads; the marker is attached from the cache once both are in.
    const startedRefresh = refreshTeamMatch(token);
    // The suggested-photos cache is keyed to this read's token; the web result below replaces it.
    beginSuggestedPhotos(token);
    const response = await mobileRead;
    if (!response.fetchFailed && Array.isArray(response.challenges)) {
        const webOverlay = await webRead;
        // Only the read that started a refresh waits for it, and for 2 s at most; every other read takes the
        // cache as it is, so a slow team read delays one list read per refresh window, never the spend-critical re-reads.
        const teamMatch = await settledTeamMatch(token, startedRefresh ? TEAM_MATCH_WAIT_MS : 0);
        let matchedPicks = 0;
        for (const challenge of response.challenges) {
            // A marked challenge is refused downstream — the overlay must not
            // make its data look healthier by merging onto it. Same for a
            // member that is present but not an object, where the old merge
            // threw on a primitive (the boundary marks both, so this is the
            // local second line of defense). The member is read into a local
            // first, so the guard's narrowing cannot union Record into the
            // property's own type for the rest of the loop body.
            if (isMarkedChallenge(challenge)) continue;
            const member = challenge.member;
            if (member !== undefined && !isPlainObject(member)) continue;
            const overlay = webOverlay?.byId.get(String(challenge.id));
            if (overlay) {
                const { turbo } = overlay;
                if (turbo && challenge.member) {
                    challenge.member.turbo = turbo;
                }
                if (overlay.guruPickIds) {
                    // Only raises: the mobile read's own guru_pick is never cleared.
                    const picks = new Set(overlay.guruPickIds);
                    for (const entry of challenge.member?.ranking?.entries ?? []) {
                        if (entry && picks.has(String(entry.id))) {
                            matchedPicks += 1;
                            entry.guru_pick = true;
                        }
                    }
                }
                // The overlay fields copy only when the web read carried them; the mobile values stay otherwise.
                if (overlay.guru_pick_enable !== undefined) challenge.guru_pick_enable = overlay.guru_pick_enable;
                if (overlay.top_photographer_enable !== undefined)
                    challenge.top_photographer_enable = overlay.top_photographer_enable;
                if (overlay.levels_rank_enable !== undefined) challenge.levels_rank_enable = overlay.levels_rank_enable;
                if (overlay.new_ranking_enable !== undefined) challenge.new_ranking_enable = overlay.new_ranking_enable;
                if (overlay.first_prizes) challenge.first_prizes = overlay.first_prizes;
                if (overlay.achievements_and_prizes)
                    challenge.achievements_and_prizes = overlay.achievements_and_prizes;
                if (overlay.benchmark) {
                    // Only `benchmark` is set: the mobile read's own total fields are never overwritten.
                    const total = (((challenge.member ??= {}).ranking ??= {}).total ??= {});
                    total.benchmark = overlay.benchmark;
                }
            }
            if (teamMatch && String(challenge.id) === teamMatch.challengeId) {
                challenge.teamMatch = teamMatch.teamMatch;
            }
        }
        // How many mobile rows carry a web pick id, whether or not they already said so:
        // picks but no matches means the two reads disagree on entry ids.
        if (webOverlay) {
            logger.withCategory('api').debug("Web Guru's picks matched against the mobile entries", {
                matched: matchedPicks,
            });
        }
        // Only a read that succeeded may rewrite the cached suggestions.
        if (webOverlay) storeSuggestedPhotos(token, webOverlay.suggestions);
        // A prune-unsafe read must not read absence from the list as "gone".
        pinChallengeTitles(response.challenges, response.pruneUnsafe === true);
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
