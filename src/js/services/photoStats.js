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
 *     actually decide (see selectEnrichmentSet in photoPicker.js), so a fill
 *     that matched the theme cleanly costs zero extra requests.
 *   - Results are cached PERSISTENTLY, so coverage accumulates across fills
 *     instead of being re-fetched. A cache hit is free and unlimited.
 *   - Only MAX_ENRICH_PER_FILL photos are newly fetched per fill, and the
 *     selection prefers photos with no cached stats. A large library therefore
 *     converges to full coverage over successive fills rather than being
 *     permanently pinned to one slice of it.
 *
 * Anything going wrong (request failure, malformed payload, rate limiting)
 * leaves the affected photo unenriched and marked stats-unknown; the picker
 * ranks it below photos with known stats rather than treating the missing
 * value as a zero. Enrichment must never turn a fill that would succeed into a
 * failure — same contract as resolveSemanticScores in autoFill.js.
 *
 * Cache scope: process-global and NOT token-scoped, so switching accounts
 * without restarting reuses entries. Accepted: photo ids are platform-unique
 * and vote counts are public data. This matches the equally unscoped vecCache
 * in services/semantic/index.js.
 *
 * Platform note: the persistent store is fs on Electron/CLI and Capacitor
 * Preferences on the Android app WebView, but MEMORY-ONLY in the Android
 * headless background service — that runtime rebuilds coverage from scratch on
 * each start.
 */

const logger = require('./../logger');
const { oneLine } = require('../format/logSafe');
const { createJsonStore } = require('../settings/storage');

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

// Vote counts move while a challenge is live, so unlike the semantic vecCache
// (whose embeddings are eternally valid and therefore never expire) these
// entries must age out. A day is long enough for coverage to accumulate across
// fills and short enough that relative ranking between photos stays honest.
const STATS_TTL_MS = 24 * 60 * 60 * 1000;

// Bounds the persisted cache. Entries are tiny (three numbers), so this is
// generous; on overflow the oldest entries are dropped.
const MAX_CACHE_ENTRIES = 5000;

// Defence-in-depth ceiling on the achievement count taken from an untrusted
// payload. Only the COUNT is ever stored or ranked on — the achievements array
// itself (which carries long descriptions and icon URLs) is never retained, so
// a huge array cannot inflate the cache or the candidate objects.
const MAX_ACHIEVEMENT_COUNT = 999;

// Photo ids are untrusted strings and become cache KEYS, so MAX_CACHE_ENTRIES
// alone does not bound the file: 5000 entries whose values are three numbers
// each is tiny, but 5000 megabyte-long keys is not. Real GuruShots ids are
// 32-char hex; anything past this is malformed and simply goes uncached (it is
// still enriched for the current fill, just never persisted). Same
// bound-the-untrusted-input reflex as MAX_LABELS_PER_PHOTO in photoPicker.js.
const MAX_PHOTO_ID_LENGTH = 128;

// Ceiling on newly fetched photos across a whole voting pass, not just one
// fill. MAX_ENRICH_PER_FILL bounds a single challenge; runVotingPass walks
// every active challenge, and a user with many of them would otherwise
// accumulate an unbounded number of third-party requests per pass. Paired with
// the consecutive-failure breaker: that one reacts to the endpoint pushing
// back, this one caps volume even when every request succeeds.
const MAX_ENRICH_PER_PASS = 200;

const statsStore = createJsonStore({ fileName: 'photo-stats.json', prefKey: 'gurushots-photo-stats' });

/** @type {Map<string, {votes: number, views: number, achievementCount: number, fetchedAt: number}>|null} */
let cache = null;
let cacheDirty = false;

// Reset per voting pass by resetPassState().
let consecutiveFailures = 0;
let breakerLoggedThisPass = false;
let fetchedThisPass = 0;
let passCapLogged = false;

// Only ids short enough to be safe cache keys are persisted; see
// MAX_PHOTO_ID_LENGTH. Returns null for anything unusable.
const cacheKeyFor = (id) => {
    if (id === undefined || id === null) return null;
    const key = String(id);
    if (key === '' || key.length > MAX_PHOTO_ID_LENGTH) return null;
    return key;
};

const nonNegInt = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
};

/**
 * Extract the three ranking signals from an untrusted get_image_data payload.
 * Everything else in the response is discarded.
 */
const toStats = (payload) => ({
    votes: nonNegInt(payload?.votes),
    views: nonNegInt(payload?.views),
    achievementCount: Math.min(
        Array.isArray(payload?.achievements) ? payload.achievements.length : 0,
        MAX_ACHIEVEMENT_COUNT,
    ),
});

const isFresh = (entry, now) =>
    entry && Number.isFinite(entry.fetchedAt) && now - entry.fetchedAt >= 0 && now - entry.fetchedAt < STATS_TTL_MS;

/**
 * Hydrate the in-memory cache from the persistent store. Any corruption is
 * treated as an empty cache — stats are a re-fetchable optimisation, never
 * something worth failing a fill over.
 */
const loadCache = () => {
    if (cache) return cache;
    cache = new Map();
    try {
        const raw = statsStore.readRaw();
        if (!raw) return cache;
        const parsed = JSON.parse(raw);
        const photos = parsed && typeof parsed === 'object' ? parsed.photos : null;
        if (!photos || typeof photos !== 'object') return cache;
        // Own-property iteration: the ids are remote-controlled, and a
        // "__proto__" key in the file must not reach the prototype chain. A Map
        // is immune to that on write, but Object.keys keeps the read honest too.
        for (const id of Object.keys(photos)) {
            const entry = photos[id];
            if (!entry || typeof entry !== 'object') continue;
            if (cacheKeyFor(id) === null) continue;
            cache.set(id, {
                votes: nonNegInt(entry.votes),
                views: nonNegInt(entry.views),
                achievementCount: Math.min(nonNegInt(entry.achievementCount), MAX_ACHIEVEMENT_COUNT),
                fetchedAt: Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0,
            });
        }
    } catch (error) {
        logger
            .withCategory('autoFill')
            .debug(`photoStats: could not read the stats cache: ${error?.message || error}`, null);
        cache = new Map();
    }
    return cache;
};

const persistCache = () => {
    if (!cacheDirty || !cache) return;
    try {
        // Drop the oldest entries when over the cap.
        if (cache.size > MAX_CACHE_ENTRIES) {
            const sorted = Array.from(cache.entries()).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
            cache = new Map(sorted.slice(0, MAX_CACHE_ENTRIES));
        }
        // Object.create(null), not {}: a photo id of "__proto__" assigned onto a
        // normal object literal hits the inherited accessor and reassigns that
        // object's prototype instead of storing a key, silently dropping the
        // entry on every write. loadCache already guards the read side with
        // Object.keys; this is the matching write-side guard.
        const photos = Object.create(null);
        for (const [id, entry] of cache) photos[id] = entry;
        statsStore.writeRaw(JSON.stringify({ version: 1, photos }));
        cacheDirty = false;
    } catch (error) {
        logger
            .withCategory('autoFill')
            .debug(`photoStats: could not persist the stats cache: ${error?.message || error}`, null);
    }
};

/**
 * Reset the per-pass failure breaker. Called at the start of each voting pass
 * so a pass that failed does not permanently disable enrichment.
 */
const resetPassState = () => {
    consecutiveFailures = 0;
    breakerLoggedThisPass = false;
    fetchedThisPass = 0;
    passCapLogged = false;
};

// Enrichment stops for the pass either because the endpoint is failing or
// because the pass has spent its request budget.
const breakerOpen = () => consecutiveFailures >= FAILURE_BREAKER_THRESHOLD || fetchedThisPass >= MAX_ENRICH_PER_PASS;

/**
 * Run `worker` over `items` at most ENRICH_CONCURRENCY at a time.
 * Rejections are contained per item — the returned array mirrors the input.
 */
const mapChunked = async (items, worker) => {
    const out = [];
    for (let i = 0; i < items.length; i += ENRICH_CONCURRENCY) {
        const chunk = items.slice(i, i + ENRICH_CONCURRENCY);
        const settled = await Promise.allSettled(chunk.map(worker));
        for (const result of settled) {
            out.push(result.status === 'fulfilled' ? result.value : null);
        }
        if (breakerOpen()) break;
    }
    return out;
};

/**
 * Enrich candidate photos with their real votes/views/achievement count.
 *
 * Returns a NEW array the same length and order as `photos`. Enriched entries
 * are shallow copies carrying `statsKnown: true`; everything else is returned
 * untouched with `statsKnown: false`. The input objects are never mutated —
 * they flow on to the submit path.
 *
 * @param {Array<object>} photos - candidates to enrich
 * @param {string} token
 * @param {{getImageData: function, logger?: object}} deps
 * @returns {Promise<Array<object>>}
 */
const enrichCandidates = async (photos, token, deps) => {
    const log = (deps && deps.logger) || logger;
    if (!Array.isArray(photos) || photos.length === 0) return [];
    const getImageData = deps && deps.getImageData;
    if (typeof getImageData !== 'function' || !token) {
        return photos.map((photo) => ({ ...photo, statsKnown: false }));
    }

    const now = Date.now();
    const store = loadCache();

    // Split into cache hits (free) and fetch candidates.
    //
    // Ordering, stated precisely because it decides which photos get measured
    // first when a contested set is bigger than one fill's budget:
    //
    //   1. Anything already fresh in the cache costs nothing and is resolved
    //      outright — it never competes for the budget.
    //   2. Among the rest, NEVER-measured photos come before ones whose entry
    //      merely went stale. A stale entry still has usable numbers from its
    //      last lookup, so spending the budget re-confirming it while another
    //      photo has never been looked at at all is strictly worse for coverage.
    //   3. Only within each of those groups does `views` order the queue.
    //
    // That third step IS a views-ranked ordering, and it is worth being honest
    // about what it does and does not do. It never feeds the ranking tiers —
    // votes/achievements/views are compared only once real numbers arrive — it
    // just picks the reading order, and views is a decent prior for "which
    // photo is likely to have lots of votes". Because measured photos leave the
    // queue permanently, coverage still reaches every candidate; views only
    // affects how soon. The original bug was views DECIDING the submission, not
    // views being consulted at all.
    const needFetch = [];
    const resolved = new Map();
    const seen = new Set();
    for (const photo of photos) {
        const id = photo && photo.id !== undefined && photo.id !== null ? String(photo.id) : null;
        if (!id) continue;
        // Callers dedupe upstream, but do not rely on it: a repeated id would
        // otherwise burn two budget slots fetching the same photo twice.
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = store.get(id);
        if (isFresh(entry, now)) {
            resolved.set(id, entry);
        } else {
            needFetch.push({ photo, everMeasured: entry !== undefined });
        }
    }

    let fetchList = [];
    if (!breakerOpen()) {
        fetchList = needFetch
            .slice()
            .sort((a, b) => {
                if (a.everMeasured !== b.everMeasured) return a.everMeasured ? 1 : -1;
                return nonNegInt(b.photo?.views) - nonNegInt(a.photo?.views);
            })
            .slice(0, MAX_ENRICH_PER_FILL)
            .map((candidate) => candidate.photo);
    }

    if (fetchList.length > 0) {
        await mapChunked(fetchList, async (photo) => {
            if (breakerOpen()) return null;
            const id = String(photo.id);
            fetchedThisPass++;
            if (fetchedThisPass >= MAX_ENRICH_PER_PASS && !passCapLogged) {
                passCapLogged = true;
                log.withCategory('autoFill').warning(
                    `autoFill: reached this cycle's limit of ${MAX_ENRICH_PER_PASS} photo-stat lookups; remaining challenges rank on what is already known and resume next cycle`,
                    null,
                );
            }
            let payload;
            try {
                payload = await getImageData(id, token);
            } catch (error) {
                log.withCategory('autoFill').debug(
                    `photoStats: get_image_data failed for photo ${oneLine(id)}: ${oneLine(error?.message || error)}`,
                    null,
                );
                payload = null;
            }
            if (!payload) {
                consecutiveFailures++;
                if (breakerOpen() && !breakerLoggedThisPass) {
                    breakerLoggedThisPass = true;
                    log.withCategory('autoFill').warning(
                        `autoFill: photo-stats lookups failed ${FAILURE_BREAKER_THRESHOLD} times in a row; skipping stat enrichment for the rest of this pass — ranking falls back to views and upload date`,
                        null,
                    );
                }
                return null;
            }
            consecutiveFailures = 0;
            const stats = { ...toStats(payload), fetchedAt: now };
            // Always usable for THIS fill; only persisted when the id is a safe
            // cache key (see MAX_PHOTO_ID_LENGTH).
            resolved.set(id, stats);
            if (cacheKeyFor(id) !== null) {
                store.set(id, stats);
                cacheDirty = true;
            }
            return null;
        });
        persistCache();
    }

    return photos.map((photo) => {
        const id = photo && photo.id !== undefined && photo.id !== null ? String(photo.id) : null;
        const stats = id ? resolved.get(id) : null;
        if (!stats) return { ...photo, statsKnown: false };
        // Assign the three ranking fields explicitly rather than spreading the
        // API payload: Object.assign/spread of an untrusted JSON object can
        // carry a "__proto__" key, and only these three are ever ranked on.
        return {
            ...photo,
            votes: stats.votes,
            views: stats.views,
            achievementCount: stats.achievementCount,
            statsKnown: true,
        };
    });
};

/** Test-only: drop the in-memory cache and per-pass breaker state. */
const __resetForTests = () => {
    cache = null;
    cacheDirty = false;
    consecutiveFailures = 0;
    breakerLoggedThisPass = false;
};

module.exports = {
    enrichCandidates,
    resetPassState,
    MAX_ENRICH_PER_FILL,
    MAX_ENRICH_PER_PASS,
    MAX_CACHE_ENTRIES,
    STATS_TTL_MS,
    FAILURE_BREAKER_THRESHOLD,
    __resetForTests,
};
