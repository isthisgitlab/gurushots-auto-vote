/** Cadence-side boundaries for relative Auto-Submit schedules. */

import { getNextScheduleThresholdSec } from '../services/autoFill/schedule';

import type { FillSchedule } from '../services/scheduleRemap';
import type { Challenge } from '../types/gurushots';

export type AutoSubmitScheduleConfig = {
    enabled: boolean;
    manualPhotosOnly: boolean;
    schedule: FillSchedule;
};

export type ResolveAutoSubmitSchedule = (
    challengeId: string,
) => AutoSubmitScheduleConfig | Promise<AutoSubmitScheduleConfig>;

export type AutoSubmitScheduleBoundary = {
    challengeId: Challenge['id'];
    challengeTitle: string;
    thresholdSec: number;
    boundaryTime: number | null;
    anyDue: boolean;
};

/**
 * The nearest future relative schedule threshold, or a due schedule when no
 * future threshold exists. Flash and unjoined challenges remain eligible:
 * staggered submission can submit to both.
 */
export const soonestAutoSubmitScheduleBoundary = async (
    challenges: Challenge[],
    now: number,
    resolveAutoSubmitSchedule: ResolveAutoSubmitSchedule,
): Promise<AutoSubmitScheduleBoundary | null> => {
    let next: AutoSubmitScheduleBoundary | null = null;
    let due: AutoSubmitScheduleBoundary | null = null;

    for (const challenge of challenges) {
        const closeTime = Number(challenge.close_time);
        const entries = challenge.member?.ranking?.entries;
        const entryCount = Array.isArray(entries) ? entries.length : 0;
        const maxPhotoSubmits = Number(challenge.max_photo_submits);
        if (!(closeTime > now) || !Number.isFinite(maxPhotoSubmits) || maxPhotoSubmits <= entryCount) continue;

        let config: AutoSubmitScheduleConfig;
        try {
            config = await resolveAutoSubmitSchedule(String(challenge.id));
        } catch {
            continue;
        }
        if (config.enabled !== true || config.manualPhotosOnly === true) continue;

        const thresholdSec = getNextScheduleThresholdSec(config.schedule, entryCount, challenge.max_photo_submits);
        if (!(thresholdSec > 0)) continue;

        const candidate = {
            challengeId: challenge.id,
            challengeTitle: challenge.title || `challenge ${challenge.id}`,
            thresholdSec,
        };
        const boundaryTime = closeTime - thresholdSec;
        if (boundaryTime <= now) {
            due ||= { ...candidate, boundaryTime: null, anyDue: true };
        } else if (!next || boundaryTime < next.boundaryTime!) {
            next = { ...candidate, boundaryTime, anyDue: false };
        }
    }

    if (next) return { ...next, anyDue: due !== null };
    return due;
};
