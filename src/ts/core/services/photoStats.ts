/**
 * GuruShots Auto Voter - Photo Stats Enrichment
 *
 * Fills in the popularity signals the library endpoint does not carry.
 *
 * WHY: get_photos_private returns `votes: 0` for every library photo and no
 * `achievements` field at all, so the auto-fill picker's popularity tiers were
 * flat zero on real data and a no-theme-match fill collapsed to views/upload
 * date — submitting an arbitrary recent photo instead of the user's strongest
 * one. /rest/get_image_data returns the real per-photo `votes`, `views` and
 * `achievements`, one photo per request.
 *
 * Because that is one request per photo, enrichment is deliberately frugal:
 *
 *   - The caller only asks for the photos whose ORDER the popularity tiers
 *     actually decide (see selectEnrichmentSet in photoPicker/tiers.ts), so a fill
 *     that matched the theme cleanly costs zero extra requests.
 *   - Results are cached PERSISTENTLY (photoStats/cache.ts), so coverage
 *     accumulates across fills instead of being re-fetched. A cache hit is
 *     free and unlimited.
 *   - Only MAX_ENRICH_PER_FILL photos are newly fetched per fill, and the
 *     selection prefers photos with no cached stats. A large library therefore
 *     converges to full coverage over successive fills rather than being
 *     permanently pinned to one slice of it.
 *
 * A second caller shares this cache: the picker's Show stats display, which
 * reads the same endpoint for the likes and Guru-picks counts shown on a
 * photo's tile. A display entry therefore carries five numbers, and one
 * without the display pair still counts as measured for ranking while a
 * display read fetches it again.
 *
 * A failed or deferred refresh keeps the last measured counts available for
 * ranking. Only a photo never measured is stats-unknown; the picker ranks it
 * below photos with known stats rather than treating missing data as zero.
 * Enrichment must never turn a fill that would succeed into a failure — same
 * contract as resolveSemanticScores in autoFill/candidates.ts.
 */

import * as logger from '../logger';
import { oneLine } from '../format/logSafe';
import { errorMessage } from '../errorMessage';
import {
    __resetCacheForTests,
    cacheKeyFor,
    isFresh,
    loadCache,
    markDirty,
    nonNegInt,
    persistCache,
    toStats,
} from './photoStats/cache';

import type { PhotoStatsEntry } from './photoStats/cache';

import type { PickerPhoto } from '../types/photoPicker';
import type { FillLogger, RankDeps } from '../types/autoFill';

// Newly fetched photos per fill. Cache hits do not count against this — a
// fully-cached candidate set enriches completely with zero requests.
const MAX_ENRICH_PER_FILL = 25;

// Concurrent in-flight requests. The endpoint is a third-party API and every
// request already multiplies through makePostRequest's retry/backoff, so keep
// the burst small.
const ENRICH_CONCURRENCY = 5;

// Consecutive failures before enrichment gives up for the rest of the voting
// pass. Without this, a rate-limited endpoint becomes a retry storm: each
// request retries with backoff, and runVotingPass repeats fills across every
// active challenge.
const FAILURE_BREAKER_THRESHOLD = 3;

// Ceiling on newly fetched photos across a whole voting pass, not just one
// fill. MAX_ENRICH_PER_FILL bounds a single challenge; runVotingPass walks
// every active challenge, and a user with many of them would otherwise
// accumulate an unbounded number of third-party requests per pass. Paired with
// the consecutive-failure breaker: that one reacts to the endpoint pushing
// back, this one caps volume even when every request succeeds.
const MAX_ENRICH_PER_PASS = 200;

/**
 * The request allowance of one run of enrichment: how many lookups it may start,
 * how many failed in a row, and whether its limits were already reported. The
 * voting pass shares one (reset by resetPassState); a run outside any pass — the
 * photo suggestions — takes its own, so it neither spends nor trips the pass's.
 * A `quiet` budget logs no limit warnings: they speak of "this pass".
 */
export type StatsBudget = {
    cap: number;
    quiet: boolean;
    consecutiveFailures: number;
    breakerLogged: boolean;
    fetched: number;
    capLogged: boolean;
};

const newBudget = (cap: number, quiet: boolean): StatsBudget => ({
    cap,
    quiet,
    consecutiveFailures: 0,
    breakerLogged: false,
    fetched: 0,
    capLogged: false,
});

// Reset per voting pass by resetPassState().
const passBudget = newBudget(MAX_ENRICH_PER_PASS, false);

/**
 * A fresh, quiet budget for a run that is not part of a voting pass: one fill's
 * lookups by default, or the caller's own cap (the photo-stats display queue
 * asks for its batch size).
 */
const createStatsBudget = (cap = MAX_ENRICH_PER_FILL): StatsBudget => newBudget(cap, true);

/**
 * Reset the per-pass failure breaker. Called at the start of each voting pass
 * so a pass that failed does not permanently disable enrichment.
 */
const resetPassState = () => {
    passBudget.consecutiveFailures = 0;
    passBudget.breakerLogged = false;
    passBudget.fetched = 0;
    passBudget.capLogged = false;
};

// Enrichment stops for the budget either because the endpoint is failing or
// because the budget has spent its requests.
const breakerOpen = (budget: StatsBudget) =>
    budget.consecutiveFailures >= FAILURE_BREAKER_THRESHOLD || budget.fetched >= budget.cap;

/** Whether the budget's failure breaker tripped: its lookups failed in a row, so the rest were skipped. */
const statsBudgetTripped = (budget: StatsBudget) => budget.consecutiveFailures >= FAILURE_BREAKER_THRESHOLD;

/**
 * Run `worker` over `items` at most ENRICH_CONCURRENCY at a time, for its side
 * effects only. allSettled keeps one item's rejection from aborting the rest
 * of its chunk.
 */
const forEachChunked = async <T>(items: T[], budget: StatsBudget, worker: (item: T) => Promise<unknown>) => {
    for (let i = 0; i < items.length; i += ENRICH_CONCURRENCY) {
        const chunk = items.slice(i, i + ENRICH_CONCURRENCY);
        await Promise.allSettled(chunk.map(worker));
        if (breakerOpen(budget)) break;
    }
};

/** The deps of one enrichment call, plus what a display read does differently. */
type EnrichDeps = Pick<RankDeps, 'getImageData' | 'statsBudget'> & {
    logger?: FillLogger;
    /** Most photos newly fetched this call (default MAX_ENRICH_PER_FILL). */
    maxFetch?: number;
    /** An entry whose likes/guruPicks are missing needs a fetch too (display reads; default false). */
    needDisplay?: boolean;
    /**
     * Land lookups in the shared store and mark it dirty (default true). With
     * false a landed lookup lives only in this call's answer: mock mode reads
     * this way, so its numbers never reach the real cache file.
     */
    persist?: boolean;
};

/** A candidate waiting for a fetch, and whether an entry (stale or complete) already measured it. */
type FetchQueueItem = { photo: PickerPhoto; everMeasured: boolean };

/** What one in-flight lookup works with: its budget, where numbers land, and how it reads. */
type FetchContext = {
    token: string;
    getImageData: NonNullable<RankDeps['getImageData']>;
    budget: StatsBudget;
    /** Every id this call has an answer for so far (cache hits included). */
    resolved: Map<string, PhotoStatsEntry>;
    store: Map<string, PhotoStatsEntry>;
    persist: boolean;
    log: typeof logger | FillLogger;
    now: number;
};

/**
 * Split candidates into cache hits (free) and fetch candidates.
 *
 * Ordering, stated precisely because it decides which photos get measured
 * first when a contested set is bigger than one fill's budget:
 *
 *   1. Anything already fresh in the cache costs nothing and is resolved
 *      outright — it never competes for the budget.
 *   2. Among the rest, NEVER-measured photos come before ones whose entry
 *      merely went stale. A stale entry still has usable numbers from its
 *      last lookup, so spending the budget re-confirming it while another
 *      photo has never been looked at at all is strictly worse for coverage.
 *   3. Only within each of those groups does `views` order the queue.
 *
 * That third step IS a views-ranked ordering, and it is worth being honest
 * about what it does and does not do. It never feeds the ranking tiers —
 * votes/achievements/views are compared only once real numbers arrive — it
 * just picks the reading order, and views is a decent prior for "which
 * photo is likely to have lots of votes". Because measured photos leave the
 * queue permanently, coverage still reaches every candidate; views only
 * affects how soon. What must never happen is views DECIDING the submission;
 * consulting views for the reading order is harmless.
 */
const splitByCache = (
    photos: PickerPhoto[],
    store: Map<string, PhotoStatsEntry>,
    now: number,
    needDisplay: boolean,
): { resolved: Map<string, PhotoStatsEntry>; needFetch: FetchQueueItem[] } => {
    const resolved: Map<string, PhotoStatsEntry> = new Map();
    const needFetch: FetchQueueItem[] = [];
    const seen: Set<string> = new Set();
    for (const photo of photos) {
        const id = photo && photo.id !== undefined && photo.id !== null ? String(photo.id) : null;
        if (!id) continue;
        // Callers dedupe upstream, but do not rely on it: a repeated id would
        // otherwise burn two budget slots fetching the same photo twice.
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = store.get(id);
        if (entry) {
            resolved.set(id, entry);
        }
        // Ranking reads an entry as done whatever it holds; a display read
        // re-fetches one that predates the display pair.
        const displayIncomplete =
            needDisplay && entry !== undefined && (entry.likes === undefined || entry.guruPicks === undefined);
        if (!isFresh(entry, now) || displayIncomplete) {
            needFetch.push({ photo, everMeasured: entry !== undefined });
        }
    }
    return { resolved, needFetch };
};

/**
 * One queued lookup: reads the photo's record and lands its numbers in the
 * call's answers (and the shared store, when this call persists). Never throws
 * — a failed read counts against the breaker and leaves the last measured
 * entry, if any, as the answer.
 */
const lookupOne = async (photo: PickerPhoto, ctx: FetchContext): Promise<null> => {
    if (breakerOpen(ctx.budget)) return null;
    const id = String(photo.id);
    ctx.budget.fetched++;
    if (ctx.budget.fetched >= ctx.budget.cap && !ctx.budget.capLogged) {
        ctx.budget.capLogged = true;
        if (!ctx.budget.quiet) {
            ctx.log
                .withCategory('autoSubmit')
                .warning(
                    `autoSubmit: reached this cycle's limit of ${MAX_ENRICH_PER_PASS} photo-stat lookups; remaining challenges rank on what is already known and resume next cycle`,
                    null,
                );
        }
    }
    let payload;
    try {
        payload = await ctx.getImageData(id, ctx.token);
    } catch (error) {
        ctx.log
            .withCategory('autoSubmit')
            .debug(
                `photoStats: get_image_data failed for photo ${oneLine(id)}: ${oneLine(errorMessage(error) || error)}`,
                null,
            );
        payload = null;
    }
    if (!payload) {
        ctx.budget.consecutiveFailures++;
        if (breakerOpen(ctx.budget) && !ctx.budget.breakerLogged) {
            ctx.budget.breakerLogged = true;
            if (!ctx.budget.quiet) {
                ctx.log
                    .withCategory('autoSubmit')
                    .warning(
                        `autoSubmit: photo-stats lookups failed ${FAILURE_BREAKER_THRESHOLD} times in a row; skipping stat enrichment for the rest of this pass — ranking falls back to views and upload date`,
                        null,
                    );
            }
        }
        return null;
    }
    ctx.budget.consecutiveFailures = 0;
    const stats = { ...toStats(payload), fetchedAt: ctx.now };
    // A successful read without the field means none of them: 0
    // completes the entry for display, so it is not refetched. An entry
    // loaded from an older cache file keeps its absent pair — that is
    // the upgrade path (loadCache leaves absent fields absent).
    if (stats.likes === undefined) stats.likes = 0;
    if (stats.guruPicks === undefined) stats.guruPicks = 0;
    // Always usable for THIS call; persisted only when persisting was
    // asked for and the id is a safe cache key (see MAX_PHOTO_ID_LENGTH).
    ctx.resolved.set(id, stats);
    if (ctx.persist && cacheKeyFor(id) !== null) {
        ctx.store.set(id, stats);
        markDirty();
    }
    return null;
};

/** Fetch the queued photos under the budget: never-measured first, then views-ranked (see splitByCache). */
const fetchQueued = async (queue: FetchQueueItem[], ctx: FetchContext, maxFetch: number): Promise<void> => {
    if (breakerOpen(ctx.budget)) return;
    const fetchList = queue
        .slice()
        .sort((a, b) => {
            if (a.everMeasured !== b.everMeasured) return a.everMeasured ? 1 : -1;
            return nonNegInt(b.photo?.views) - nonNegInt(a.photo?.views);
        })
        .slice(0, maxFetch)
        .map((candidate) => candidate.photo);
    if (fetchList.length === 0) return;
    await forEachChunked(fetchList, ctx.budget, (photo) => lookupOne(photo, ctx));
    persistCache();
};

/** The answer array: the input order, each photo a copy carrying its landed numbers. */
const applyResolved = (photos: PickerPhoto[], resolved: Map<string, PhotoStatsEntry>): PickerPhoto[] =>
    photos.map((photo) => {
        const id = photo && photo.id !== undefined && photo.id !== null ? String(photo.id) : null;
        const stats = id ? resolved.get(id) : null;
        if (!stats) return { ...photo, statsKnown: false };
        // Assign the ranking fields explicitly rather than spreading the
        // API payload: Object.assign/spread of an untrusted JSON object can
        // carry a "__proto__" key, and only these fields are ever kept.
        return {
            ...photo,
            votes: stats.votes,
            views: stats.views,
            achievementCount: stats.achievementCount,
            ...(stats.likes === undefined ? null : { likes: stats.likes }),
            ...(stats.guruPicks === undefined ? null : { guruPicks: stats.guruPicks }),
            statsKnown: true,
        };
    });

/**
 * Enrich candidate photos with their real votes/views/achievement count, and
 * — when the entry has them — the likes/Guru-picks display pair.
 *
 * Returns a NEW array the same length and order as `photos`. Enriched entries
 * are shallow copies carrying `statsKnown: true`; everything else is returned
 * untouched with `statsKnown: false`. The input objects are never mutated —
 * they flow on to the submit path.
 *
 * @param photos - candidates to enrich
 */
const enrichCandidates = async (photos: PickerPhoto[], token: string, deps: EnrichDeps): Promise<PickerPhoto[]> => {
    const log = (deps && deps.logger) || logger;
    const budget = deps?.statsBudget ?? passBudget;
    const maxFetch = deps?.maxFetch ?? MAX_ENRICH_PER_FILL;
    const needDisplay = deps?.needDisplay === true;
    const persist = deps?.persist !== false;
    if (!Array.isArray(photos) || photos.length === 0) return [];
    const getImageData = deps && deps.getImageData;
    if (typeof getImageData !== 'function' || !token) {
        return photos.map((photo) => ({ ...photo, statsKnown: false }));
    }

    const now = Date.now();
    const store = loadCache();
    const { resolved, needFetch } = splitByCache(photos, store, now, needDisplay);
    await fetchQueued(needFetch, { token, getImageData, budget, resolved, store, persist, log, now }, maxFetch);
    return applyResolved(photos, resolved);
};

/** Test-only: drop the in-memory cache and per-pass budget state. */
const __resetForTests = () => {
    __resetCacheForTests();
    resetPassState();
};

export { initializePhotoStatsAsync, flushPhotoStatsWrites, STATS_TTL_MS, MAX_CACHE_ENTRIES } from './photoStats/cache';
export type { PhotoStatsFile } from './photoStats/cache';

export {
    enrichCandidates,
    resetPassState,
    createStatsBudget,
    statsBudgetTripped,
    MAX_ENRICH_PER_FILL,
    MAX_ENRICH_PER_PASS,
    __resetForTests,
};
