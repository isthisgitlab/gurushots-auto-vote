/**
 * GuruShots Auto Voter - Challenges Module
 *
 * This module handles fetching active challenges for the authenticated user.
 */

import { makePostRequest, createCommonHeaders } from './api-client';
import { ENDPOINTS, createWebHeaders } from './constants';
import * as logger from '../logger';
import { isPlainObject } from '../plainObject';
import { normalizeActiveChallenges } from '../challengeIntegrity';

import type {
    ActiveChallengesResponse,
    MemberTurbo,
    Prize,
    PrizeTier,
    RankingTotal,
    WebActiveChallengesResponse,
} from '../types/gurushots';

/**
 * Fetches all active challenges for the authenticated user — one request per
 * call. Title pinning and in-flight coalescing live in the caller
 * (strategies/real/activeChallenges.ts).
 *
 * @param token - Authentication token
 * @returns Response containing array of active challenges — run through the
 *   boundary (normalizeActiveChallenges, with app-set stripping on), so every
 *   challenge is checked once: malformed ones carry `dataIssues`, elements
 *   without an id are dropped (`pruneUnsafe`) — or
 *   `{ challenges: [], fetchFailed: true }` if the request fails
 */
const fetchActiveChallenges = async (token: string): Promise<ActiveChallengesResponse> => {
    const operationId = 'get-active-challenges';
    logger.withCategory('api').startOperation(operationId, 'Fetching active challenges', 'DEBUG');

    // Log only presence, never any slice of the token itself — a `tokenPrefix`
    // field does not match the logger's SENSITIVE_KEY_RE redaction allowlist, so
    // the first bytes of the real bearer token would land in api-*.log in
    // cleartext (log files get pasted into bug reports). `hasToken` is enough.
    logger.withCategory('api').debug('Requesting active challenges from API', {
        hasToken: !!token,
    });

    const headers = createCommonHeaders(token);
    const response = await makePostRequest<ActiveChallengesResponse>(ENDPOINTS.activeChallenges, headers);

    // Handle failed requests gracefully. The empty list keeps every existing consumer
    // working, but it is flagged so callers can tell "the fetch failed" apart from "you
    // genuinely have no active challenges" — makePostRequest resolves null once retries are
    // exhausted (e.g. GuruShots returning 5xx), and without this marker a dead API produced
    // a pass that reported success with "No active challenges found" and re-armed as if
    // everything were healthy.
    if (!response) {
        logger.withCategory('api').endOperation(operationId, null, 'API request failed');
        return { challenges: [], fetchFailed: true };
    }

    const challengeCount = response.challenges ? response.challenges.length : 0;

    // Log successful response
    logger.withCategory('api').debug('Active challenges response received', {
        challengeCount,
        hasValidStructure: !!response.challenges,
        responseKeys: Object.keys(response),
    });

    logger.withCategory('api').endOperation(operationId, `retrieved ${challengeCount} challenges`);
    // The boundary runs before anything sees the list (the overlay merge
    // included); the debug lines above still log the body as it arrived.
    return normalizeActiveChallenges(response, true);
};

// aislop-ignore-next-line ai-slop/thin-wrapper -- type guard narrowing to MemberTurbo; isPlainObject only narrows to Record<string, unknown>
const isMemberTurbo = (value: unknown): value is MemberTurbo => isPlainObject(value);

const isObjectArray = <T extends object>(value: unknown): value is T[] =>
    Array.isArray(value) && value.every((element) => isPlainObject(element));

/**
 * The tier with its `prizes` kept only when that, too, is an array of plain objects — a tier whose
 * `prizes` is anything else drops the field, so a `{}` never reaches the renderer's `.map`.
 */
const readPrizeTier = (tier: PrizeTier): PrizeTier => {
    if (isObjectArray<Prize>(tier.prizes)) return tier;
    const narrowed: PrizeTier = { ...tier };
    delete narrowed.prizes;
    return narrowed;
};

/** One benchmark row, as `RankingTotal.benchmark` carries it; scores stay strings, parsed at display time. */
type BenchmarkRow = NonNullable<RankingTotal['benchmark']>[number];

/**
 * What the WEB get_my_active_challenges overlays onto one challenge of the
 * mobile list: its turbo (the only read that reports a `mode`), the ids of the
 * member's entries the web read marks `guru_pick`, plus the challenge-level
 * fields the mobile read omits. A field that fails its shape check is left off
 * the overlay, so the mobile value stands.
 */
interface WebChallengeOverlay {
    turbo: MemberTurbo | null;
    /** `String(id)` of each web entry with `guru_pick: true`; absent when the element carries no entries array. */
    guruPickIds?: string[];
    guru_pick_enable?: boolean;
    top_photographer_enable?: boolean;
    levels_rank_enable?: boolean;
    new_ranking_enable?: boolean;
    first_prizes?: Prize[];
    achievements_and_prizes?: PrizeTier[];
    benchmark?: BenchmarkRow[];
}

/** The whole web read: per-challenge overlays by id, plus the raw suggested library photo ids per un-joined challenge. */
interface WebActiveOverlay {
    byId: Map<string, WebChallengeOverlay>;
    suggestions: Map<string, string[]>;
}

/**
 * Reads one challenge's overlay off its web element. The turbo keeps the exact
 * old semantics (null when the member or the turbo is not an object); every
 * other field is taken only when its shape checks out. The Guru's picks are a
 * set of string ids, never object keys, and nothing else is copied from the
 * web entries — the mobile rows stay the source of everything else.
 */
const readOverlay = (element: Record<string, unknown>): WebChallengeOverlay => {
    const overlay: WebChallengeOverlay = { turbo: null };
    const member = isPlainObject(element.member) ? element.member : null;
    if (member) {
        overlay.turbo = isMemberTurbo(member.turbo) ? member.turbo : null;
        if (isPlainObject(member.ranking)) {
            if (isPlainObject(member.ranking.total)) {
                const benchmark = member.ranking.total.benchmark;
                if (isObjectArray<BenchmarkRow>(benchmark)) overlay.benchmark = benchmark;
            }
            if (Array.isArray(member.ranking.entries)) {
                const entries: unknown[] = member.ranking.entries;
                const guruPickIds: string[] = [];
                for (const entry of entries) {
                    if (
                        isPlainObject(entry) &&
                        (typeof entry.id === 'string' || typeof entry.id === 'number') &&
                        entry.guru_pick === true
                    ) {
                        guruPickIds.push(String(entry.id));
                    }
                }
                overlay.guruPickIds = guruPickIds;
            }
        }
    }
    if (typeof element.guru_pick_enable === 'boolean') overlay.guru_pick_enable = element.guru_pick_enable;
    if (typeof element.top_photographer_enable === 'boolean')
        overlay.top_photographer_enable = element.top_photographer_enable;
    if (typeof element.levels_rank_enable === 'boolean') overlay.levels_rank_enable = element.levels_rank_enable;
    if (typeof element.new_ranking_enable === 'boolean') overlay.new_ranking_enable = element.new_ranking_enable;
    if (isObjectArray<Prize>(element.first_prizes)) overlay.first_prizes = element.first_prizes;
    if (isObjectArray<PrizeTier>(element.achievements_and_prizes))
        overlay.achievements_and_prizes = element.achievements_and_prizes.map(readPrizeTier);
    return overlay;
};

/**
 * Reads the top-level `suggested_challenges` — the member's own library photos
 * GuruShots suggests per challenge they have NOT joined — as each entry's id →
 * the raw `member.suggested_images` ids (the suggested-photos cache filters
 * them). The field's elements are untrusted wire data, so they are
 * shape-checked here; a missing or malformed field reads as an empty map.
 */
const readSuggestions = (response: WebActiveChallengesResponse): Map<string, string[]> => {
    const suggestions = new Map<string, string[]>();
    if (!Array.isArray(response.suggested_challenges)) return suggestions;
    const entries: unknown[] = response.suggested_challenges;
    for (const entry of entries) {
        if (!isPlainObject(entry) || (typeof entry.id !== 'string' && typeof entry.id !== 'number')) continue;
        if (!isPlainObject(entry.member) || !Array.isArray(entry.member.suggested_images)) continue;
        const images: unknown[] = entry.member.suggested_images;
        const ids: string[] = [];
        for (const image of images) {
            if (!isPlainObject(image) || (typeof image.id !== 'string' && typeof image.id !== 'number')) continue;
            ids.push(String(image.id));
        }
        suggestions.set(String(entry.id), ids);
    }
    return suggestions;
};

/**
 * Reads the WEB get_my_active_challenges — the only read that reports the
 * turbo `mode` ('classic' | 'snap') and the snap-aware turbo state, the
 * per-entry Guru's picks (the mobile read may not carry the per-entry flag), and the
 * challenge-level fields the mobile read omits, plus the photo ids suggested
 * per challenge the member has NOT joined. The body also carries other
 * members' profile data, which is never logged (it is on
 * BODY_UNLOGGED_URLS); only flags and counts reach the log.
 *
 * @param token - Authentication token
 * @returns Each challenge id (string) → its overlay, and each
 *   `suggested_challenges` id → its raw suggested photo ids, or null when the
 *   request failed or the body carries no challenge list
 */
const fetchWebActiveOverlay = async (token: string): Promise<WebActiveOverlay | null> => {
    const response = await makePostRequest<WebActiveChallengesResponse>(
        ENDPOINTS.webActiveChallenges,
        createWebHeaders(token),
        '',
    );
    if (!response || !Array.isArray(response.challenges)) {
        logger.withCategory('api').warning("Web active challenges unavailable; turbo mode and Guru's picks unknown", {
            requestFailed: !response,
        });
        return null;
    }
    const byId = new Map<string, WebChallengeOverlay>();
    const elements: unknown[] = response.challenges;
    let entriesPresent = false;
    let guruPickCount = 0;
    for (const element of elements) {
        if (!isPlainObject(element) || (typeof element.id !== 'string' && typeof element.id !== 'number')) continue;
        const overlay = readOverlay(element);
        byId.set(String(element.id), overlay);
        if (overlay.guruPickIds !== undefined) {
            entriesPresent = true;
            guruPickCount += overlay.guruPickIds.length;
        }
    }
    // Counts only, never ids or bodies: the URL stays on BODY_UNLOGGED_URLS.
    logger.withCategory('api').debug('Web active challenges overlay read', {
        challenges: byId.size,
        guruPickIds: guruPickCount,
        entriesPresent,
    });
    return { byId, suggestions: readSuggestions(response) };
};

export { fetchActiveChallenges, fetchWebActiveOverlay };
export type { WebChallengeOverlay };
