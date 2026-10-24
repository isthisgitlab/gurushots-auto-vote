/**
 * The persistent per-photo stats cache behind photoStats.ts: what a cached
 * entry holds, how an untrusted get_image_data payload is reduced to it, and
 * the load/persist cycle over the platform JSON store.
 *
 * WHY A CACHE: the real numbers live in /rest/get_image_data, one request per
 * photo, so every caller (the ranking enrichment, the picker's Show stats
 * display) reads through here — a cache hit is free, and coverage accumulates
 * across runs instead of being re-fetched.
 *
 * Cache scope: process-global and NOT token-scoped, so switching accounts
 * without restarting reuses entries. Accepted: photo ids are platform-unique
 * and vote counts are public data. This matches the equally unscoped vecCache
 * in services/semantic/index.ts.
 *
 * Platform note: the persistent store is fs on Electron/CLI and Capacitor
 * Preferences on the Android app WebView, but MEMORY-ONLY in the Android
 * headless background service — that runtime rebuilds coverage from scratch on
 * each start.
 */

import * as logger from '../../logger';
import { createJsonStore } from '../../settings/storage';
import { isPlainObject } from '../../plainObject';
import { errorMessage } from '../../errorMessage';

/**
 * One photo's cached ranking signals, plus — when a display read landed them —
 * the likes and Guru-picks counts the tile shows.
 */
type PhotoStatsEntry = {
    votes: number;
    views: number;
    achievementCount: number;
    fetchedAt: number;
    likes?: number;
    guruPicks?: number;
};

/** The persisted stats cache file. */
export type PhotoStatsFile = { version: number; photos: Record<string, PhotoStatsEntry> };

// Vote counts move while a challenge is live, so refresh after a day. Expiry
// schedules a new lookup; it must not erase the last measured vote count from
// ranking when the lookup budget or an API failure postpones that refresh.
const STATS_TTL_MS = 24 * 60 * 60 * 1000;

// Bounds the persisted cache. Entries are tiny (six numbers), so this is
// generous; on overflow the oldest entries are dropped.
const MAX_CACHE_ENTRIES = 5000;

// Defence-in-depth ceiling on the achievement count taken from an untrusted
// payload. Only the COUNT is ever stored or ranked on — the achievements array
// itself (which carries long descriptions and icon URLs) is never retained, so
// a huge array cannot inflate the cache or the candidate objects.
const MAX_ACHIEVEMENT_COUNT = 999;

// Photo ids are untrusted strings and become cache KEYS, so MAX_CACHE_ENTRIES
// alone does not bound the file: 5000 entries whose values are six numbers
// each is tiny, but 5000 megabyte-long keys is not. Real GuruShots ids are
// 32-char hex; anything past this is malformed and simply goes uncached (it is
// still enriched for the current fill, just never persisted). Same
// bound-the-untrusted-input reflex as MAX_LABELS_PER_PHOTO in photoPicker/labels.ts.
const MAX_PHOTO_ID_LENGTH = 128;

const statsStore = createJsonStore({ fileName: 'photo-stats.json', prefKey: 'gurushots-photo-stats' });

let cache: Map<string, PhotoStatsEntry> | null = null;
let cacheDirty = false;

// Only ids short enough to be safe cache keys are persisted; see
// MAX_PHOTO_ID_LENGTH. Both callers pass an already-stringified id (a persisted
// Object.keys key, or String(photo.id)). Returns null for anything unusable.
const cacheKeyFor = (id: string): string | null => {
    if (id === '' || id.length > MAX_PHOTO_ID_LENGTH) return null;
    return id;
};

const nonNegInt = (value: unknown): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
};

/**
 * Extract the ranking signals and the display pair from an untrusted
 * get_image_data payload. Numbers only: no member_id, title or other server
 * text is ever retained. A display count the payload lacks stays absent, so a
 * display read can still tell the entry needs one.
 */
const toStats = (
    payload:
        | {
              votes?: number;
              views?: number;
              likes?: number;
              guru_picks?: number;
              achievements?: unknown[];
          }
        | null
        | undefined,
): PhotoStatsEntry => ({
    votes: nonNegInt(payload?.votes),
    views: nonNegInt(payload?.views),
    achievementCount: Math.min(
        Array.isArray(payload?.achievements) ? payload.achievements.length : 0,
        MAX_ACHIEVEMENT_COUNT,
    ),
    fetchedAt: 0,
    ...(payload?.likes === undefined ? null : { likes: nonNegInt(payload.likes) }),
    ...(payload?.guru_picks === undefined ? null : { guruPicks: nonNegInt(payload.guru_picks) }),
});

const isFresh = (entry: PhotoStatsEntry | undefined, now: number) =>
    entry && Number.isFinite(entry.fetchedAt) && now - entry.fetchedAt >= 0 && now - entry.fetchedAt < STATS_TTL_MS;

/** Mark the in-memory cache changed, so the next persistCache writes it out. */
const markDirty = () => {
    cacheDirty = true;
};

/**
 * Hydrate the in-memory cache from the persistent store. Any corruption is
 * treated as an empty cache — stats are a re-fetchable optimisation, never
 * something worth failing a fill over.
 */
const loadCache = (): Map<string, PhotoStatsEntry> => {
    if (cache) return cache;
    cache = new Map();
    try {
        const raw = statsStore.readRaw();
        if (!raw) return cache;
        const parsed: unknown = JSON.parse(raw);
        const photos = isPlainObject(parsed) ? parsed.photos : null;
        if (!isPlainObject(photos)) return cache;
        // Own-property iteration: the ids are remote-controlled, and a
        // "__proto__" key in the file must not reach the prototype chain. A Map
        // is immune to that on write, but Object.keys keeps the read honest too.
        for (const id of Object.keys(photos)) {
            const entry = photos[id];
            if (!isPlainObject(entry)) continue;
            if (cacheKeyFor(id) === null) continue;
            cache.set(id, {
                votes: nonNegInt(entry.votes),
                views: nonNegInt(entry.views),
                achievementCount: Math.min(nonNegInt(entry.achievementCount), MAX_ACHIEVEMENT_COUNT),
                fetchedAt: Number.isFinite(entry.fetchedAt) ? (entry.fetchedAt as number) : 0,
                // A display pair an older entry lacks stays absent; a present one still goes
                // through the same number-only read as the ranking fields.
                ...(entry.likes === undefined ? null : { likes: nonNegInt(entry.likes) }),
                ...(entry.guruPicks === undefined ? null : { guruPicks: nonNegInt(entry.guruPicks) }),
            });
        }
    } catch (error) {
        logger
            .withCategory('autoSubmit')
            .debug(`photoStats: could not read the stats cache: ${errorMessage(error) || error}`, null);
        cache = new Map();
    }
    return cache;
};

const persistCache = () => {
    if (!cacheDirty || !cache) return;
    try {
        // Drop the oldest entries when over the cap — IN PLACE: a call that
        // started earlier still holds this same Map as its store, and replacing
        // it would send that call's landed lookups into a Map nobody reads.
        if (cache.size > MAX_CACHE_ENTRIES) {
            const sorted = Array.from(cache.entries()).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
            for (const [id] of sorted.slice(MAX_CACHE_ENTRIES)) cache.delete(id);
        }
        // Object.create(null), not {}: a photo id of "__proto__" assigned onto a
        // normal object literal hits the inherited accessor and reassigns that
        // object's prototype instead of storing a key, silently dropping the
        // entry on every write. loadCache already guards the read side with
        // Object.keys; this is the matching write-side guard.
        const photos = Object.create(null) as Record<string, PhotoStatsEntry>;
        for (const [id, entry] of cache) photos[id] = entry;
        const file: PhotoStatsFile = { version: 1, photos };
        statsStore.writeRaw(JSON.stringify(file));
        cacheDirty = false;
    } catch (error) {
        logger
            .withCategory('autoSubmit')
            .debug(`photoStats: could not persist the stats cache: ${errorMessage(error) || error}`, null);
    }
};

/** Test-only: drop the in-memory cache state. */
const __resetCacheForTests = () => {
    cache = null;
    cacheDirty = false;
};

export const initializePhotoStatsAsync = statsStore.initializeAsync;
export const flushPhotoStatsWrites = statsStore.flushPendingWrites;

export {
    STATS_TTL_MS,
    MAX_CACHE_ENTRIES,
    cacheKeyFor,
    nonNegInt,
    toStats,
    isFresh,
    markDirty,
    loadCache,
    persistCache,
    __resetCacheForTests,
};
export type { PhotoStatsEntry };
