/**
 * Real-strategy suggested-photos cache: the member's own library photo ids the
 * WEB active-challenge read suggests per challenge they have NOT joined. The
 * ids ride the same read that feeds the challenge list, so they live in a
 * one-slot in-memory cache beside it (the teamMatch.ts pattern, including its
 * `latestToken` guard), replaced on each successful web read and never
 * persisted. They are only ever intersected with the member's own library
 * photos, so the ids are not owner-filtered here — a foreign id simply matches
 * nothing.
 */

// A library photo id is a 32-character lowercase hex string.
const LIBRARY_ID_RE = /^[0-9a-f]{32}$/;
// The suggestion list can be long; the join's photo pick only needs a handful.
const MAX_PER_CHALLENGE = 20;

interface Slot {
    token: string;
    suggestions: Map<string, string[]>;
}

// Only the current token's slot is kept, so a signed-out token is not.
let slot: Slot | null = null;
let latestToken = '';

const keepIds = (ids: string[]): string[] => {
    const kept: string[] = [];
    for (const id of ids) {
        if (!LIBRARY_ID_RE.test(id)) continue;
        kept.push(id);
        if (kept.length >= MAX_PER_CHALLENGE) break;
    }
    return kept;
};

/**
 * Notes the token an active-challenge read is starting for and drops the slot
 * of another token; an empty token (signed out) drops it too. The web read of
 * that call replaces the cache on success (storeSuggestedPhotos) and leaves it
 * alone on failure.
 */
const beginSuggestedPhotos = (token: string): void => {
    latestToken = token;
    if (slot?.token !== token) slot = null;
};

/**
 * Replaces the cache from the suggestions map of a successful web
 * active-challenge read. A store for another token than the one the latest
 * read started for is discarded — an old read landing late — and so is an
 * empty token's.
 */
const storeSuggestedPhotos = (token: string, suggestions: Map<string, string[]>): void => {
    if (!token || token !== latestToken) return;
    const kept = new Map<string, string[]>();
    for (const [challengeId, ids] of suggestions) {
        kept.set(challengeId, keepIds(ids));
    }
    slot = { token, suggestions: kept };
};

/**
 * The library photo ids suggested for this challenge, or an empty list when
 * nothing is cached for this token and challenge. Never rejects.
 */
const getSuggestedPhotoIds = async (token: string, challengeId: string | number): Promise<string[]> => {
    if (!token) return [];
    const cached = slot && slot.token === token ? slot.suggestions.get(String(challengeId)) : undefined;
    return cached ?? [];
};

export { beginSuggestedPhotos, getSuggestedPhotoIds, storeSuggestedPhotos };
