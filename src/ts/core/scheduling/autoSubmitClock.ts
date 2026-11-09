/** Cadence-side boundaries for Auto-Submit clock windows. */

import { getAutoSubmitClockWindowState } from './autoSubmitWindow';

import type { Challenge } from '../types/gurushots';

export type AutoSubmitClockConfig = {
    enabled: boolean;
    manualPhotosOnly: boolean;
    times: unknown;
    windowMinutes: unknown;
};

export type ResolveAutoSubmitClock = (challengeId: string) => AutoSubmitClockConfig | Promise<AutoSubmitClockConfig>;

export type AutoSubmitClockBoundary = {
    challengeId: Challenge['id'];
    challengeTitle: string;
    startTime: number;
    endTime: number | null;
    active: boolean;
    anyActive: boolean;
    boundaryTime: number;
};

const hasRemainingSlots = (challenge: Challenge): boolean => {
    const max = Number(challenge.max_photo_submits);
    const entries = challenge.member?.ranking?.entries;
    return Number.isFinite(max) && max > (Array.isArray(entries) ? entries.length : 0);
};

/**
 * The nearest active window or future window start among challenges the
 * Auto-Submit runner can actually submit to. Flash challenges are included:
 * unlike last-minute voting, staggered submission has no flash exclusion.
 */
export const soonestAutoSubmitClockBoundary = async (
    challenges: Challenge[],
    now: number,
    resolveAutoSubmitClock: ResolveAutoSubmitClock,
    timezone: string,
): Promise<AutoSubmitClockBoundary | null> => {
    const eligible = challenges.filter(
        (challenge) => Number(challenge.close_time) > now && hasRemainingSlots(challenge),
    );
    const configs = await Promise.all(
        eligible.map(async (challenge) => {
            try {
                return await resolveAutoSubmitClock(String(challenge.id));
            } catch {
                return null;
            }
        }),
    );

    let best: AutoSubmitClockBoundary | null = null;
    let anyActive = false;
    for (let index = 0; index < eligible.length; index++) {
        const challenge = eligible[index]!;
        const config = configs[index];
        if (!config || config.enabled !== true || config.manualPhotosOnly === true) continue;
        const state = getAutoSubmitClockWindowState(config.times, config.windowMinutes, timezone, now);
        const closeTime = Number(challenge.close_time);
        const title = challenge.title || `challenge ${challenge.id}`;
        const candidates: AutoSubmitClockBoundary[] = [];
        if (state.active) {
            candidates.push({
                challengeId: challenge.id,
                challengeTitle: title,
                startTime: now,
                endTime: Math.min(state.activeUntil!, closeTime),
                active: true,
                anyActive: true,
                boundaryTime: Math.min(state.activeUntil!, closeTime),
            });
        }
        if (state.nextStart !== null && state.nextStart < closeTime) {
            candidates.push({
                challengeId: challenge.id,
                challengeTitle: title,
                startTime: state.nextStart,
                endTime: null,
                active: false,
                anyActive: false,
                boundaryTime: state.nextStart,
            });
        }
        if (state.active) anyActive = true;
        for (const candidate of candidates) {
            if (!best || candidate.boundaryTime < best.boundaryTime) best = candidate;
        }
    }
    return best ? { ...best, anyActive } : null;
};
