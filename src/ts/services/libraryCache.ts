/**
 * The photo-library listing the photo choosers open with, kept in memory only (never written to disk) so a
 * chooser opened again does not wait for a walk of the whole library.
 *
 * Each listing is kept per account (by a hash of the token, never the token), per challenge and per usage
 * (submit or swap): its eligibility marks are that challenge's own for that usage, and so is what the
 * challenge's rules accept. A challenge's entry answers a chooser for that challenge and usage only while it is
 * under LIBRARY_FRESH_MS old; anything else is answered from `latest`, the newest listing read for any
 * challenge or usage, which is only ever shown as a preview with its marks withheld. Entries are frozen and
 * every answer is a copy, so nothing a caller does to an answer reaches the cache.
 *
 * The account's own actions in this window (a submit, a fill, a join, a swap) drop a challenge's entries, of
 * every usage (`dropContext`), and so do the automatic ones (a new entry reflected on the pass's challenge, a
 * swap, a join: `dropChallenge`, which has no token at hand and drops the challenge for every account). A read that was running
 * meanwhile writes nothing, whichever challenge was dropped (`dropEpoch`). A logout or account switch empties
 * everything (`clearLibraryCache`).
 */

import * as logger from '../logger';
import { tokenKey } from './accountScope';

import type { LibraryUsage } from '../types/photoPicker';

/** One library photo as the listing hands it out. */
type ListedPhoto = {
    id: string;
    labels: string[];
    allowed: boolean;
    message: string | null;
    uploadDate: number | null;
};

/** What a library read came to: the photos with what was said about them, and where the read stopped (`nextStart`, the offset a continuation read starts at). */
type LibraryListing = {
    photos: ListedPhoto[];
    memberId: string | null;
    wonIds: string[];
    wonCount: number;
    truncated: boolean;
    nextStart: number;
    allowedKnown: boolean;
};

/** A listing and when its read began, in unix milliseconds. */
type TimedListing = LibraryListing & { readAtMs: number };

type Entry = { readAtMs: number; listing: Readonly<TimedListing> };

/** How long a challenge's listing answers a chooser for that challenge. */
const LIBRARY_FRESH_MS = 5 * 60_000;

/** Most (challenge, usage) pairs kept at once. */
const MAX_LIBRARY_ENTRIES = 12;

const entries = new Map<string, Entry>();
let latest: { account: string; listing: Readonly<TimedListing> } | null = null;
// Counts every drop: a read compares it before and after its walk.
let dropCount = 0;

const log = (kind: string): void => logger.withCategory('autoSubmit').debug(`Library cache: ${kind}`, null);

const USAGES: readonly LibraryUsage[] = ['submit', 'swap'];

/**
 * The key of one challenge's entry for a usage (null: the settings and rules choosers, which name none) for an
 * account. The challenge comes last, which `dropChallenge` matches.
 */
const keyOf = (token: string, contextId: string | number | null, usage: LibraryUsage): string =>
    `${tokenKey(token)}:${usage}:${contextId === null ? 'none' : `id:${contextId}`}`;

const copyPhoto = (photo: ListedPhoto): ListedPhoto => ({ ...photo, labels: [...photo.labels] });

const copyOf = (listing: TimedListing): TimedListing => ({
    ...listing,
    photos: listing.photos.map(copyPhoto),
    wonIds: [...listing.wonIds],
});

const frozen = (listing: TimedListing): Readonly<TimedListing> => {
    const copy = copyOf(listing);
    for (const photo of copy.photos) {
        Object.freeze(photo.labels);
        Object.freeze(photo);
    }
    Object.freeze(copy.photos);
    Object.freeze(copy.wonIds);
    return Object.freeze(copy);
};

const isExpired = (readAtMs: number, now: number): boolean => now - readAtMs >= LIBRARY_FRESH_MS;

const evictExpired = (now: number): void => {
    for (const [key, entry] of entries) {
        if (isExpired(entry.readAtMs, now)) entries.delete(key);
    }
};

/** The challenge's listing for the usage when it was read less than LIBRARY_FRESH_MS ago, as a copy; else null. */
const readFresh = (
    token: string,
    contextId: string | number | null,
    usage: LibraryUsage = 'submit',
    now: number = Date.now(),
): TimedListing | null => {
    evictExpired(now);
    const entry = entries.get(keyOf(token, contextId, usage));
    return entry ? copyOf(entry.listing) : null;
};

/** The newest listing the account has read for any challenge or usage, as a copy, however old; else null. */
const readLatest = (token: string): TimedListing | null =>
    latest && latest.account === tokenKey(token) ? copyOf(latest.listing) : null;

const oldestKey = (): string => {
    let oldest = '';
    let oldestAt = Infinity;
    for (const [key, entry] of entries) {
        if (entry.readAtMs < oldestAt) {
            oldest = key;
            oldestAt = entry.readAtMs;
        }
    }
    return oldest;
};

/** Keeps a challenge's listing for a usage (and as the newest, when it is), evicting what has expired and what is over the cap. */
const writeListing = (
    token: string,
    contextId: string | number | null,
    listing: TimedListing,
    usage: LibraryUsage = 'submit',
    now: number = Date.now(),
): void => {
    evictExpired(now);
    const key = keyOf(token, contextId, usage);
    const kept = frozen(listing);
    entries.delete(key);
    entries.set(key, { readAtMs: kept.readAtMs, listing: kept });
    while (entries.size > MAX_LIBRARY_ENTRIES) entries.delete(oldestKey());
    const account = tokenKey(token);
    if (latest === null || latest.account !== account || kept.readAtMs >= latest.listing.readAtMs) {
        latest = { account, listing: kept };
    }
    log('stored');
};

/**
 * The challenge's listings are out of date (the app has just changed what it can enter): forget them, of every
 * usage, so the next opening reads again, and make a read that is in flight write nothing. `latest` stays: it
 * is only ever shown as a preview, with its marks withheld.
 */
const dropContext = (token: string, contextId: string | number | null): void => {
    for (const usage of USAGES) entries.delete(keyOf(token, contextId, usage));
    dropCount += 1;
    log('dropped');
};

/** Same as `dropContext`, for the code that has the challenge but not the token: every account's entries of it go. */
const dropChallenge = (contextId: string | number): void => {
    const suffix = `:id:${contextId}`;
    for (const key of entries.keys()) {
        if (key.endsWith(suffix)) entries.delete(key);
    }
    dropCount += 1;
    log('dropped');
};

/** How many drops there have been: a read compares it before and after its walk, and writes only if it held. */
const dropEpoch = (): number => dropCount;

/** Forget everything (an account left, and tests start clean). */
const clearLibraryCache = (): void => {
    entries.clear();
    latest = null;
};

export {
    readFresh,
    readLatest,
    writeListing,
    dropContext,
    dropChallenge,
    dropEpoch,
    clearLibraryCache,
    LIBRARY_FRESH_MS,
    MAX_LIBRARY_ENTRIES,
};
export type { TimedListing };
