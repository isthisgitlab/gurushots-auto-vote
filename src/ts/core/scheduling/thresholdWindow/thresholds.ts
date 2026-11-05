/** Last-minute threshold resolution and in-window / next-entry queries. Must stay free of settings I/O: the WebView bundle imports it. */

import { eligibleChallenges } from '../scheduledFill';
import { challengeLabel } from './shared';

import type { Challenge } from '../../types/gurushots';
import type { ThresholdEntry } from './shared';

/**
 * @param challengeId - Challenge id as a string.
 * @returns The effective lastMinuteThreshold (minutes).
 */
export type ResolveThreshold = (challengeId: string) => number | Promise<number>;

/**
 * Resolve each eligible challenge's per-challenge threshold ONCE. Every
 * threshold question (in-window? next entry? next delay?) is then answered from
 * this single resolved snapshot — important because on the WebView each
 * `resolveThreshold` call is an IPC round-trip, and on Node it re-reads the
 * settings file, so resolving per-question would double the cost and could even
 * read two different `now`s mid-decision.
 *
 * @param now - Unix timestamp (seconds)
 */
export async function resolveEligibleThresholds(
    challenges: Challenge[],
    now: number,
    resolveThreshold: ResolveThreshold,
): Promise<{ eligible: Challenge[]; thresholds: number[] }> {
    const eligible = eligibleChallenges(challenges, now);
    // Promise.resolve is what Promise.all already applies to each element, so
    // wrapping here is behavior-identical; it only types every element as a
    // Promise for the await-thenable lint (a resolver may be sync).
    const thresholds = await Promise.all(eligible.map((c) => Promise.resolve(resolveThreshold(c.id.toString()))));
    return { eligible, thresholds };
}

// Pure decision helpers over an already-resolved (eligible, thresholds) snapshot.
export const anyInWindow = (eligible: Challenge[], thresholds: number[], now: number) =>
    eligible.some((c, i) => c.close_time - now <= thresholds[i] * 60);

export const soonestThresholdEntry = (
    eligible: Challenge[],
    thresholds: number[],
    now: number,
): ThresholdEntry | null => {
    let nextEntry: ThresholdEntry | null = null;
    let earliestEntryTime = Infinity;
    for (let i = 0; i < eligible.length; i++) {
        const challenge = eligible[i];
        const effectiveLastMinuteThreshold = thresholds[i];
        const thresholdEntryTime = challenge.close_time - effectiveLastMinuteThreshold * 60;
        if (thresholdEntryTime > now && thresholdEntryTime < earliestEntryTime) {
            earliestEntryTime = thresholdEntryTime;
            nextEntry = {
                challengeId: challenge.id,
                challengeTitle: challengeLabel(challenge),
                entryTime: thresholdEntryTime,
                lastMinuteThreshold: effectiveLastMinuteThreshold,
            };
        }
    }
    return nextEntry;
};

/**
 * Find the soonest challenge that will cross its per-challenge
 * `lastMinuteThreshold` boundary after `now`. Returns null when none will.
 *
 * @param now - Unix timestamp (seconds)
 */
export async function calculateNextThresholdEntry(
    challenges: Challenge[],
    now: number,
    resolveThreshold: ResolveThreshold,
): Promise<ThresholdEntry | null> {
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);
    return soonestThresholdEntry(eligible, thresholds, now);
}

/**
 * True when at least one non-flash, still-open challenge is currently inside
 * its per-challenge `lastMinuteThreshold` window (inclusive boundary). Used to
 * decide when to leave the fixed last-minute cadence and revert to normal.
 *
 * @param now - Unix timestamp (seconds)
 */
export async function isAnyChallengeInThresholdWindow(
    challenges: Challenge[],
    now: number,
    resolveThreshold: ResolveThreshold,
): Promise<boolean> {
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);
    return anyInWindow(eligible, thresholds, now);
}
