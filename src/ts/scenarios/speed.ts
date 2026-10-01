/**
 * Vote speed: how fast each entry is collecting votes, from the vote counts
 * the scenario runner samples once per pass into the challenge's scenario
 * state (`history: { photoId: [[unixSec, votes], …] }`). Keyed by photo id,
 * so a photo keeps its history when it is swapped out and back in — its
 * votes travel with it.
 *
 * Pure and dependency-free. A speed that cannot be measured honestly (no
 * history old enough, a single entry to compare against) is null, and every
 * condition treats null as "does not hold".
 */

/** Minimum spacing between two samples of the same photo. */
const SAMPLE_SPACING_SEC = 5 * 60;
/** Samples older than this are dropped. */
const HISTORY_KEEP_SEC = 48 * 3600;
/** Samples kept per photo (with the spacing above, ~25 h at the densest). */
const MAX_SAMPLES = 300;
/** A speed needs at least this much history behind it. */
const MIN_SPAN_SEC = 10 * 60;
/** Speed window when a condition or selector does not name one. */
const DEFAULT_WINDOW_SEC = 3600;

import type { RankingEntry } from '../types/gurushots';

export type VoteHistory = Record<string, Array<[number, number]>>;

const votesOf = (value: number | null | undefined) =>
    value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * History with a sample for every entry whose votes are readable (spaced at
 * least SAMPLE_SPACING_SEC apart), trimmed to HISTORY_KEEP_SEC and
 * MAX_SAMPLES. Photos no longer seen keep their samples until they age out, so
 * a photo swapped out for a day still has its history when it comes back.
 */
const recordVoteSample = (
    history: VoteHistory | undefined,
    entries: readonly RankingEntry[],
    now: number,
): VoteHistory => {
    const next: VoteHistory = {};
    for (const [id, samples] of Object.entries(history ?? {})) {
        const kept = samples.filter(([at]) => now - at <= HISTORY_KEEP_SEC);
        if (kept.length) next[id] = kept;
    }
    for (const entry of entries) {
        const votes = votesOf(entry?.votes);
        if (votes === null || entry?.id === undefined || entry?.id === null) continue;
        const id = String(entry.id);
        const samples = next[id] ?? [];
        const last = samples[samples.length - 1];
        if (!last || now - last[0] >= SAMPLE_SPACING_SEC) samples.push([now, votes]);
        next[id] = samples.slice(-MAX_SAMPLES);
    }
    return next;
};

/**
 * Votes per hour over the last `windowSec` (or over the history there is, if
 * shorter but at least MIN_SPAN_SEC), from the entry's live vote count.
 */
const votesPerHour = (
    history: VoteHistory | undefined,
    entry: RankingEntry,
    now: number,
    windowSec: number = DEFAULT_WINDOW_SEC,
): number | null => {
    const votes = votesOf(entry?.votes);
    const samples = history?.[String(entry?.id)];
    if (votes === null || !samples?.length) return null;
    const from = now - windowSec;
    // The newest sample at or before the window start, else the oldest one.
    let base = samples[0];
    for (const sample of samples) if (sample[0] <= from) base = sample;
    const span = now - base[0];
    if (span < MIN_SPAN_SEC) return null;
    return ((votes - base[1]) * 3600) / span;
};

/**
 * The entry's speed divided by the median speed of the member's OTHER
 * entries. Infinity when the others are not gaining at all but this one is;
 * null when there is nothing to compare with.
 */
const speedRatio = (
    history: VoteHistory | undefined,
    entries: readonly RankingEntry[],
    entry: RankingEntry,
    now: number,
    windowSec: number = DEFAULT_WINDOW_SEC,
): number | null => {
    const own = votesPerHour(history, entry, now, windowSec);
    if (own === null) return null;
    const others: number[] = [];
    for (const other of entries) {
        const speed = other === entry ? null : votesPerHour(history, other, now, windowSec);
        if (speed !== null) others.push(speed);
    }
    if (!others.length) return null;
    others.sort((a, b) => a - b);
    const middle = Math.floor(others.length / 2);
    const median = others.length % 2 ? others[middle] : (others[middle - 1] + others[middle]) / 2;
    if (median > 0) return own / median;
    return own > 0 ? Infinity : 0;
};

export {
    recordVoteSample,
    votesPerHour,
    speedRatio,
    DEFAULT_WINDOW_SEC,
    SAMPLE_SPACING_SEC,
    HISTORY_KEEP_SEC,
    MAX_SAMPLES,
};
