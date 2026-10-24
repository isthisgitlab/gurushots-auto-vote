/**
 * The get-photo-stats IPC handler: the per-photo display stats behind the
 * picker's Show stats line (see actions/library.ts for its sibling listing
 * handler).
 */

import * as settings from '../../settings';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import * as auth from '../../services/auth';
import { createStatsBudget, enrichCandidates, statsBudgetTripped } from '../../services/photoStats';
import { CHOSEN_PHOTO_ID_RE, LIBRARY_BATCH_PHOTOS } from '../../settings/limits';
import { errorResult } from '../errorResult';
import { refuseInvalidArgs } from './shared';
import { SUPERSEDED, createThrottle } from './throttle';

import type { IpcReplyFn } from '../registerHandlers';

// Shortest gap between the end of one stats-queue run and the start of the next. A display read is
// one get_image_data per photo, so a stuck Retry key must not queue burst after burst either.
const STATS_MIN_INTERVAL_MS = 1500;

// After a stats call's failure breaker trips, later calls answer every uncached
// id as missing without fetching, for this long. GuruShots pushing back on one
// burst should not be met with another.
const STATS_COOLDOWN_MS = 60_000;

const statsThrottle = createThrottle(STATS_MIN_INTERVAL_MS);

// When the cool-down ends (unix ms): 0 when none is running. Set after a call's
// failure breaker trips; a cache-only cool-down call never extends it.
let statsCooldownUntil = 0;

/**
 * One answered display stat: the four numbers a picker tile shows. `stats`
 * carries only ids with all four; everything else asked for is in `missing`.
 */
type PhotoStatsAnswer = { id: string; votes: number; views: number; likes: number; guruPicks: number };

/**
 * Display stats for the picker's Show stats line: votes, views, likes and Guru
 * picks per photo id, read from get_image_data through the shared
 * `services/photoStats.ts` cache.
 *
 * Security notes:
 *  - Any well-formed id can be asked for. Accepted: reaching this handler
 *    already takes a compromised window, the four numbers are public photo
 *    data, and the cache they land in is bounded (MAX_CACHE_ENTRIES).
 *  - Display lookups share the ranking cache (5000 entries) with the voting
 *    pass; an overflowing cache evicts the oldest entries.
 *  - Like that cache, the answer is not token-scoped — on purpose. Do not copy
 *    this pattern to account data.
 *
 * The queue is the listing walk's single-flight pattern (actions/throttle.ts)
 * with its own instance and gap (STATS_MIN_INTERVAL_MS); a newer call replaces
 * a queued one (`superseded`). In mock mode the numbers come from the mock
 * strategy and are never persisted. After a call's failure breaker trips,
 * later calls answer every uncached id as missing without fetching for
 * STATS_COOLDOWN_MS.
 */
const handleGetPhotoStats = (async (event: unknown, ids?: unknown) => {
    if (!Array.isArray(ids)) return refuseInvalidArgs('autoSubmit', 'get-photo-stats');
    const photoIds: string[] = [];
    for (const id of ids) {
        if (typeof id !== 'string' || !CHOSEN_PHOTO_ID_RE.test(id)) {
            return refuseInvalidArgs('autoSubmit', 'get-photo-stats');
        }
        photoIds.push(id);
    }
    // Deduped first: the cap bounds the work done, and a list of repeats is not more of it.
    if (new Set(photoIds).size > LIBRARY_BATCH_PHOTOS) {
        return refuseInvalidArgs('autoSubmit', 'get-photo-stats');
    }
    try {
        const guard = auth.requireAuthToken('photo stats');
        if (!guard.ok) return guard.response;
        const { token } = guard;
        const mock = settings.getSetting('mock') === true;
        const getImageData = apiFactory.getApiStrategy().getImageData;
        const unique = [...new Set(photoIds)];
        const outcome = await statsThrottle.run(async () => {
            // Read the cool-down (and budget for it) INSIDE the queued job: a
            // call that waited behind another one must see a cool-down that
            // call started, not the state at enqueue time.
            const cooling = Date.now() < statsCooldownUntil;
            // A cool-down call fetches nothing: a budget already at its cap makes
            // enrichCandidates answer from the cache alone.
            const budget = createStatsBudget(cooling ? 0 : LIBRARY_BATCH_PHOTOS);
            const enriched = await enrichCandidates(
                unique.map((id) => ({ id })),
                token,
                {
                    getImageData,
                    statsBudget: budget,
                    maxFetch: LIBRARY_BATCH_PHOTOS,
                    needDisplay: true,
                    persist: !mock,
                },
            );
            return { budget, enriched };
        });
        if (outcome === SUPERSEDED) return { success: false as const, error: 'superseded' as const };
        if (statsBudgetTripped(outcome.budget)) statsCooldownUntil = Date.now() + STATS_COOLDOWN_MS;
        const stats: PhotoStatsAnswer[] = [];
        const missing: string[] = [];
        for (const photo of outcome.enriched) {
            // The display pair decides: an entry whose likes or guruPicks never
            // landed (no entry, or a fetch that failed) is missing, stale
            // numbers notwithstanding. When they are numbers, so are votes and
            // views — every entry carries them — and the check keeps the
            // answer typed without claiming more than was read.
            if (
                typeof photo.votes === 'number' &&
                typeof photo.views === 'number' &&
                typeof photo.likes === 'number' &&
                typeof photo.guruPicks === 'number'
            ) {
                stats.push({
                    id: photo.id,
                    votes: photo.votes,
                    views: photo.views,
                    likes: photo.likes,
                    guruPicks: photo.guruPicks,
                });
            } else {
                missing.push(photo.id);
            }
        }
        // Counts only: never the ids and never a response.
        logger
            .withCategory('autoSubmit')
            .debug(`get-photo-stats: ${stats.length} answered, ${missing.length} missing`, null);
        return { success: true as const, stats, missing };
    } catch (error) {
        logger.withCategory('autoSubmit').error('Error handling get-photo-stats request:', error);
        return errorResult(error, 'Failed to read your photo stats');
    }
}) satisfies IpcReplyFn;

// Test-only: forget the stats queue and its cool-down between cases.
const __resetPhotoStatsThrottle = (): void => {
    statsThrottle.reset();
    statsCooldownUntil = 0;
};

export { handleGetPhotoStats, __resetPhotoStatsThrottle, STATS_MIN_INTERVAL_MS, STATS_COOLDOWN_MS };
