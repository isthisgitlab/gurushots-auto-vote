import type { Challenge } from '../../types/gurushots';
import type { RankedChallenge } from '../../types/rendererUtils';
/**
 * At-a-glance "needs attention" predicates for the challenge list, so a user
 * opening the app can spot what matters without reading every card: an open
 * boost window, and exposure that has run (nearly) dry. Pure and shared by
 * ChallengeCard, ChallengeNav, LowExposureBanner and StatusHeader so they can
 * never disagree on which challenges are flagged.
 *
 * Display-only — the voting engine keeps its own per-challenge thresholds.
 */

// Exposure at or below this percentage is flagged. 10% catches the "about to
// hit zero" cards as well as the ones already at 0.
export const LOW_EXPOSURE_THRESHOLD = 10;

/**
 * Whether a challenge's exposure is low enough to flag. Only running
 * challenges count: before start there is nothing to vote for, and after close
 * a 0% is final rather than actionable.
 *
 * @param challenge - Active challenge from the API
 * @param now - Current time (Unix seconds)
 */
export const isLowExposure = (challenge: Challenge, now: number): boolean => {
    const exposure = challenge?.member?.ranking?.exposure?.exposure_factor;
    if (typeof exposure !== 'number') return false;
    if (!(challenge.start_time < now) || !(challenge.close_time > now)) return false;
    return exposure <= LOW_EXPOSURE_THRESHOLD;
};

/**
 * Challenges with low exposure as display entries, lowest exposure first.
 *
 * @param challenges - Active challenges from the API
 * @param now - Current time (Unix seconds)
 */
export const lowExposureChallenges = (
    challenges: Challenge[] | null | undefined,
    now: number,
): Array<{ id: Challenge['id']; title: string; exposure: number }> =>
    (challenges || [])
        .filter((c): c is RankedChallenge => isLowExposure(c, now))
        .map((c) => ({ id: c.id, title: c.title, exposure: c.member.ranking.exposure.exposure_factor }))
        .sort((a, b) => a.exposure - b.exposure);
