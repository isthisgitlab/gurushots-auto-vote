import type { Challenge } from '../../types/gurushots';

/**
 * Which boundary (if any) decided the next cycle's delay.
 */
export type CadenceMode =
    | 'last-minute'
    | 'approaching'
    | 'scheduled'
    | 'pre-final-window'
    | 'pre-boost'
    | 'boost-hold'
    | 'currency-rule'
    | 'scenario'
    | 'normal';

/**
 * A lead-window boundary (pre-final-window top-up / pre-boost fill).
 */
export type LeadWindowStart = {
    challengeId: Challenge['id'];
    challengeTitle: string;
    startTime: number;
    leadMin: number;
};

/**
 * The soonest challenge crossing its lastMinuteThreshold.
 */
export type ThresholdEntry = {
    challengeId: Challenge['id'];
    challengeTitle: string;
    entryTime: number;
    lastMinuteThreshold: number;
};

export type CurrencyRuleStart = {
    challengeId: Challenge['id'];
    challengeTitle: string;
    startTime: number;
    action: 'key' | 'swap' | 'fill';
};

export type ScenarioWakeStart = {
    challengeId: Challenge['id'];
    challengeTitle: string;
    startTime: number;
    phase: string;
};

export type BoostHoldEnd = { challengeId: Challenge['id']; challengeTitle: string; startTime: number };

/**
 * Resolve each challenge's per-challenge config in parallel, fail-soft: a
 * resolver that throws yields null for that challenge, which the caller skips.
 */
export const resolveConfigsFailSoft = <T>(
    challenges: Challenge[],
    resolve: (challengeId: string) => T | Promise<T>,
): Promise<Array<T | null>> =>
    Promise.all(
        challenges.map(async (challenge) => {
            try {
                return await resolve(challenge.id.toString());
            } catch {
                return null;
            }
        }),
    );

// Fall back to the id so a missing/empty title never logs as "undefined".
export const challengeLabel = (challenge: Challenge) => challenge.title || `challenge ${challenge.id}`;

// 60..3540s == 1..59 min; mirrors VotingLogic's lead-minute clamps (rawLeadMin,
// getBoostPrefillLeadSec) so a corrupt sub-minute/over-max override falls back
// to the schema default (15 min) identically here.
export const clampLeadSec = (leadSec: number) =>
    Number.isFinite(leadSec) && leadSec >= 60 && leadSec <= 3540 ? leadSec : 900;

// Strictly after `now` and sooner than the best boundary found so far (none yet
// = Infinity, so a non-finite start never wins).
export const isSoonerUpcomingStart = (startTime: number, now: number, best: { startTime: number } | null) =>
    startTime > now && startTime < (best ? best.startTime : Infinity);

export const leadWindowStart = (challenge: Challenge, startTime: number, leadSec: number): LeadWindowStart => ({
    challengeId: challenge.id,
    challengeTitle: challengeLabel(challenge),
    startTime,
    leadMin: Math.round(leadSec / 60),
});
