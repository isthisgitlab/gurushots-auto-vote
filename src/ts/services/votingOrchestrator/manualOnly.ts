import * as logger from '../../logger';
import * as settings from '../../settings';
import { isManualPhotosOnly } from '../manualPhotosOnly';
import { detectNewEntry, rebaselineEntrySnapshot } from './newEntries';

import type { Challenge } from '../../types/gurushots';
import type { PassContext } from './context';

/** The scoped Run's no-op message and the per-challenge skip line, one template. */
export const manualOnlyOnLine = (challenge: Challenge): string =>
    `${logger.challengeTag(challenge)} Manual Only is on — nothing runs automatically`;

/**
 * Whether the pass may not run anything on this challenge, read for a decision made OUTSIDE the
 * per-challenge `try` (the mission quota, the scoped Run): a switch read that throws counts as
 * Manual Only there, so nothing is spent on a challenge whose state can't be read.
 */
export const isManualOnlyFailClosed = (challenge: Challenge): boolean => {
    try {
        return isManualPhotosOnly(settings, challenge?.id);
    } catch {
        return true;
    }
};

// Challenge ids the pass already reported as Manual Only, so entering and leaving the state is
// logged once rather than on every pass (the same shape as voteStallReported in missionVotes.ts).
const reportedSkipped = new Set<string>();

// Test hook: forget which challenges were reported as skipped.
export const resetManualOnlyLog = () => {
    reportedSkipped.clear();
};

/** Forget reports for challenges that are no longer active. */
export const pruneManualOnlyLog = (allChallenges: Challenge[]) => {
    const active = new Set(allChallenges.map((challenge) => String(challenge?.id)));
    for (const id of reportedSkipped) {
        if (!active.has(id)) reportedSkipped.delete(id);
    }
};

/**
 * The pass's per-challenge gate: true when the challenge is Manual Only and was skipped. A skipped
 * challenge still keeps the read-only ledgers current (entry ages, the new-entry snapshot), so
 * switching the mode off later triggers no burst of catch-up actions. The read is live and may
 * throw; the caller's per-challenge `try` turns that into a skipped challenge.
 */
export const skipIfManualOnly = (challenge: Challenge, now: number, pass: PassContext): boolean => {
    const id = String(challenge.id);
    if (!isManualPhotosOnly(settings, challenge.id)) {
        if (reportedSkipped.delete(id)) {
            logger
                .withCategory('voting')
                .info(`${logger.challengeTag(challenge)} Manual Only is off — automatic rules resume`, null);
        }
        return false;
    }
    if (!reportedSkipped.has(id)) {
        reportedSkipped.add(id);
        logger.withCategory('voting').info(manualOnlyOnLine(challenge), null);
    }
    pass.entryAges?.observe(challenge, now);
    rebaselineEntrySnapshot(pass.entryTracker, detectNewEntry(challenge, pass.entryTracker));
    return true;
};
