/** Pre-final-window top-up and pre-boost prefill lead-window wakes. Must stay free of settings I/O: the WebView bundle imports it. */

import { boostApplyThreshold } from '../../voting/boostWindow';
import { resolveConfigsFailSoft, clampLeadSec, isSoonerUpcomingStart, leadWindowStart } from './shared';

import type { Challenge } from '../../types/gurushots';
import type { LeadWindowStart } from './shared';

/**
 * Per-challenge pre-final-window-top-up config for the cadence cap.
 *
 * @param challengeId - Challenge id as a string.
 */
export type ResolveFinalWindowTopUp = (challengeId: string) => FinalWindowTopUpConfig | Promise<FinalWindowTopUpConfig>;

type FinalWindowTopUpConfig = { enabled: boolean; leadSec: number; durationSec: number };

/**
 * Top-up window start for one challenge, or null when its config is off/unreadable.
 */
const finalWindowTopUpWindow = (
    challenge: Challenge,
    config: FinalWindowTopUpConfig | null,
): { startTime: number; leadSec: number } | null => {
    if (!config || config.enabled !== true) return null;
    const leadSec = clampLeadSec(config.leadSec);
    // Mirrors VotingLogic's finalWindowSec clamp (>= 60s, else the default hour).
    const durationSec = Number.isFinite(config.durationSec) && config.durationSec >= 60 ? config.durationSec : 3600;
    return { startTime: Number(challenge.close_time) - (durationSec + leadSec), leadSec };
};

/**
 * Soonest upcoming pre-final-window top-up window START strictly after `now`
 * across still-open, non-flash challenges. The window opens `leadSec` before the
 * final window, i.e. at `close_time - (durationSec + leadSec)` — the scheduler
 * caps its sleep to this so a cycle lands exactly there and tops the challenge up
 * to the standard target before the final-window rule's lower trigger takes over.
 *
 * Fail-soft like the other cadence helpers: a challenge whose resolver throws or
 * whose config is disabled/corrupt is skipped; an out-of-range leadSec (sub-minute,
 * over 59 min, or NaN) falls back to the schema default (15 min) so a bad override
 * can't disable the cap. The valid range mirrors VotingLogic's rule-engine guard
 * (1..59 min) so the two same-purpose guards can't drift on corrupt input. A
 * corrupt durationSec (sub-minute or NaN) falls back to the default fixed hour
 * (3600), mirroring VotingLogic's finalWindowSec clamp for the same input.
 *
 * @param eligible - already-filtered still-open non-flash challenges
 * @param now - Unix timestamp (seconds)
 */
export async function soonestFinalWindowTopUpStart(
    eligible: Challenge[],
    now: number,
    resolveFinalWindowTopUp: ResolveFinalWindowTopUp,
): Promise<LeadWindowStart | null> {
    const configs = await resolveConfigsFailSoft(eligible, resolveFinalWindowTopUp);
    let best: LeadWindowStart | null = null;
    for (let i = 0; i < eligible.length; i++) {
        const window = finalWindowTopUpWindow(eligible[i], configs[i]);
        if (window && isSoonerUpcomingStart(window.startTime, now, best)) {
            best = leadWindowStart(eligible[i], window.startTime, window.leadSec);
        }
    }
    return best;
}

/**
 * Per-challenge pre-boost-fill config for the cadence cap. The two boost windows
 * come through as already-resolved numbers so this module stays free of settings
 * I/O (it is bundled into the WebView); the apply instant itself is computed from
 * the challenge's own live boost state via the shared boostApplyThreshold.
 *
 * @param challengeId - Challenge id as a string.
 */
export type ResolveBoostPrefill = (challengeId: string) => BoostPrefillConfig | Promise<BoostPrefillConfig>;

type BoostPrefillConfig = {
    enabled: boolean;
    leadSec: number;
    boostTimeSec: number;
    keyUnlockedBoostTimeSec: number;
};

/**
 * Pre-boost fill window start for one challenge, or null when it has none.
 */
const boostPrefillWindow = (
    challenge: Challenge,
    config: BoostPrefillConfig | null,
): { startTime: number; leadSec: number } | null => {
    if (!config || config.enabled !== true) return null;
    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return null;

    const boostTimeSec = Number(config.boostTimeSec);
    // Mirrors VotingLogic.getEffectiveKeyUnlockedBoostTime: an explicit 0 is the
    // off sentinel and must be honoured, but a missing/negative/NaN value falls
    // back to the schema default rather than skipping the challenge — otherwise
    // the rule would be armed at 900s for a boundary the scheduler never wakes for.
    const rawKeyUnlocked = Number(config.keyUnlockedBoostTimeSec);
    const keyUnlockedBoostTimeSec = Number.isFinite(rawKeyUnlocked) && rawKeyUnlocked >= 0 ? rawKeyUnlocked : 900;
    const { thresholdSec, branch } = boostApplyThreshold(challenge.member?.boost, closeTime, {
        boostTimeSec,
        keyUnlockedBoostTimeSec,
    });
    if (branch === null) return null;
    // `0 = off` on the window this branch actually measures against; mirrors
    // VotingLogic.getBoostPrefillState.
    const windowSec = branch === 'timer' ? boostTimeSec : keyUnlockedBoostTimeSec;
    if (!Number.isFinite(windowSec) || windowSec <= 0) return null;
    if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return null;

    const leadSec = clampLeadSec(config.leadSec);
    return { startTime: closeTime - (thresholdSec + leadSec), leadSec };
};

/**
 * Soonest upcoming pre-boost fill window START strictly after `now` across
 * still-open, non-flash challenges. The window opens `leadSec` before the boost
 * is auto-applied, i.e. at `close_time - (applyThresholdSec + leadSec)` — the
 * scheduler caps its sleep to this so a cycle lands there and can start voting
 * the challenge to 100% before the boost is spent on it.
 *
 * Unlike the other cadence boundaries this one depends on LIVE challenge state
 * (`member.boost`), not on close_time alone, so it can appear, move or vanish as
 * the boost's own timer is refreshed server-side. That is fine: it is recomputed
 * from scratch every cycle, and the vote rule re-checks the same window before
 * acting.
 *
 * Fail-soft like the other cadence helpers: a challenge whose resolver throws or
 * whose config is disabled is skipped. An out-of-range leadSec (sub-minute, over
 * 59 min, or NaN) falls back to the schema default (15 min) so a bad override
 * can't disable the cap — the valid range mirrors VotingLogic's
 * getBoostPrefillLeadSec so the two same-purpose guards can't drift. The
 * `0 = off` sentinel on whichever boost window the branch measures against is
 * honoured here exactly as the vote rule honours it, so the scheduler never wakes
 * for a fill the rule would then decline to perform.
 *
 * @param eligible - already-filtered still-open non-flash challenges
 * @param now - Unix timestamp (seconds)
 */
export async function soonestBoostPrefillStart(
    eligible: Challenge[],
    now: number,
    resolveBoostPrefill: ResolveBoostPrefill,
): Promise<LeadWindowStart | null> {
    const configs = await resolveConfigsFailSoft(eligible, resolveBoostPrefill);
    let best: LeadWindowStart | null = null;
    for (let i = 0; i < eligible.length; i++) {
        const window = boostPrefillWindow(eligible[i], configs[i]);
        if (window && isSoonerUpcomingStart(window.startTime, now, best)) {
            best = leadWindowStart(eligible[i], window.startTime, window.leadSec);
        }
    }
    return best;
}
