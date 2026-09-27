import type { Challenge } from '../../types/gurushots';
/**
 * Boost and turbo apply decisions, including the Emergency Fill override.
 * Part of the services/VotingLogic facade.
 */

import * as settings from '../../settings';
import { isBoostWindowOpen as boostWindowOpen } from '../../voting/boostWindow';
import { getEffectiveBoostTime, getEffectiveKeyUnlockedBoostTime, getEffectiveTurboTime } from './thresholds';
import { pickEntryAvoidingConflict } from './entryPick';

export interface TurboDecision {
    apply: boolean;
    imageId: string | null;
    fillNew: boolean;
    reason: string;
}

/**
 * True when the per-challenge Emergency Fill window is enabled (> 0) and the
 * challenge is currently inside it (closing within that many seconds). Mirrors
 * the window check in autoFill.maybeEmergencyFillChallenge.
 *
 * Used by the boost/turbo APPLY paths so that at the buzzer an available boost
 * or won turbo gets used even when its own auto-apply toggle is off — an unused
 * boost/turbo on a closing challenge is simply wasted. Returns false (no
 * override) when Emergency Fill is disabled, so a user can opt out by setting it
 * to 0.
 * @param now - Unix timestamp in seconds
 */
const isWithinEmergencyWindow = (challenge: Challenge, now: number): boolean => {
    if (!challenge) return false;
    const challengeId = challenge.id?.toString?.() || '';
    const emergencySeconds = settings.getEffectiveSetting('emergencyFill', challengeId);
    if (!Number.isFinite(emergencySeconds) || emergencySeconds <= 0) return false;
    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return false;
    const secondsRemaining = closeTime - now;
    return secondsRemaining > 0 && secondsRemaining <= emergencySeconds;
};

/**
 * Check if boost should be applied to a challenge
 * - Timer-based available (state === 'AVAILABLE' with timeout):
 *   apply when timeUntilBoostExpires <= effectiveBoostTime
 * - Key-unlocked available (state === 'AVAILABLE_KEY' or available with no timeout):
 *   ignore boost timer completely and apply only if challenge ends in next 15 minutes
 * @param challenge - Challenge object
 * @param now - Current time (Unix timestamp)
 * @param options - When `emergency` is true and the
 *   challenge is inside the Emergency Fill window, apply any available boost
 *   regardless of the autoBoost toggle or the boostTime window.
 * @returns True if boost should be applied
 */
const shouldApplyBoost = (challenge: Challenge, now: number, options: { emergency?: boolean } = {}): boolean => {
    if (!challenge) return false;

    // Never apply if challenge already ended or not started yet
    if (challenge.close_time <= now) return false;

    const challengeId = challenge.id?.toString?.() || '';

    // Emergency override: inside the Emergency Fill window, apply an available
    // boost even when autoBoost is off — at the buzzer an unused boost is wasted.
    const emergency = options.emergency === true && isWithinEmergencyWindow(challenge, now);
    if (!emergency && !settings.getEffectiveSetting('autoBoost', challengeId)) return false;

    // In the emergency window the boostTime threshold no longer matters (the
    // challenge is about to close), so apply whenever a boost is actually
    // available to apply — mirrors isBoostWindowOpen.
    if (emergency) return isBoostWindowOpen(challenge, now);

    const effectiveBoostTime = getEffectiveBoostTime(challengeId); // seconds

    const boost = challenge.member?.boost || {};
    const boostState = boost.state;
    const timeout = typeof boost.timeout === 'number' ? boost.timeout : 0;
    const hasTimeout = timeout > 0;

    // Determine if this is a key-unlocked availability
    // Treat AVAILABLE without timeout as key-unlocked as well
    const isKeyUnlocked = boostState === 'AVAILABLE_KEY' || (boostState === 'AVAILABLE' && !hasTimeout);

    const timeUntilEnd = challenge.close_time - now;

    if (isKeyUnlocked) {
        // A key-unlocked boost has no timer of its own, so it is measured against the
        // challenge's close time via its own setting (was a hardcoded 15 minutes).
        return timeUntilEnd > 0 && timeUntilEnd <= getEffectiveKeyUnlockedBoostTime(challengeId);
    }

    // Timer-based AVAILABLE with a timeout: use existing effectiveBoostTime window
    if (boostState === 'AVAILABLE' && hasTimeout) {
        const timeUntilBoostExpires = timeout - now;
        return timeUntilBoostExpires > 0 && timeUntilBoostExpires <= effectiveBoostTime;
    }

    // All other states: do not auto-apply
    return false;
};

/**
 * Seconds before the boost's deadline by which a held boost must have been
 * released: one last-minute poll, so the cycle that releases it still lands
 * before the boost expires (timer boost) or the challenge closes (key-unlocked).
 */
const BOOST_HOLD_MARGIN_SEC = 60;

/**
 * When a due boost must wait for its target photo: the instant that photo has
 * been in the challenge `boostFreshEntryWait` seconds, or null to boost now.
 * A boost spent on a photo the moment it is entered gets few votes.
 *
 * Never holds a boost it could lose: when the wait would not end
 * BOOST_HOLD_MARGIN_SEC before the boost's own deadline (its timeout for a timer
 * boost, the close time for a key-unlocked one), the boost goes now. An unknown
 * entry time (null, or 0 = already there when the app first saw the challenge)
 * never holds.
 * @param enteredAt - when the target entry entered (Unix seconds)
 * @param now - Unix timestamp in seconds
 */
const getBoostHoldUntil = (challenge: Challenge, enteredAt: number | null, now: number): number | null => {
    const waitSec = settings.getEffectiveSetting('boostFreshEntryWait', challenge.id.toString());
    if (!Number.isFinite(waitSec) || waitSec <= 0 || !Number.isFinite(enteredAt) || Number(enteredAt) <= 0) {
        return null;
    }
    const holdUntil = Number(enteredAt) + waitSec;
    if (holdUntil <= now) return null;
    const timeout = challenge.member?.boost?.timeout;
    const deadline =
        challenge.member?.boost?.state === 'AVAILABLE' && typeof timeout === 'number' && timeout > 0
            ? timeout
            : Number(challenge.close_time);
    return holdUntil <= deadline - BOOST_HOLD_MARGIN_SEC ? holdUntil : null;
};

/**
 * Returns true while the boost window is currently usable (state AVAILABLE
 * with an active timer, or AVAILABLE_KEY / AVAILABLE without timeout).
 * Used by shouldApplyBoost (its emergency path) and describeDeadlineActions
 * (the boost/turbo entry-conflict flag).
 * Predicate itself is shared with the renderer (voting/boostWindow.ts).
 * @param now - Unix timestamp in seconds
 */
const isBoostWindowOpen = (challenge: Challenge, now: number): boolean =>
    boostWindowOpen(challenge?.member?.boost, now);

/**
 * Decides whether to play the Turbo mini-game on a challenge.
 * @param now - Unix timestamp in seconds
 */
const shouldPlayAutoTurbo = (challenge: Challenge, now: number): boolean => {
    if (!challenge) return false;
    if (challenge.close_time <= now) return false;

    const challengeId = challenge.id?.toString?.() || '';
    if (!settings.getEffectiveSetting('autoTurbo', challengeId)) return false;

    const turbo = challenge.member?.turbo || {};
    const state = turbo.state;
    if (state === 'FREE' || state === 'IN_PROGRESS') return true;
    if (state === 'TIMER' && typeof turbo.time_to_open === 'number' && turbo.time_to_open <= now) {
        return true;
    }
    return false;
};

// A saved turbo is earned this long before its apply window (turboTime). It
// must cover one full check interval so a cycle is sure to land in between:
// the settings UI caps the interval at 60 minutes, and no scheduler wake-up
// backs this (a hand-edited longer interval could reach the apply window with
// the turbo unearned). Earning doesn't fail, so no retry slack.
const SAVED_TURBO_EARN_LEAD_SEC = 3600;

/**
 * Whether an earnable turbo stays unearned this pass: Save Turbos for Missions
 * is on and the challenge is still more than SAVED_TURBO_EARN_LEAD_SEC ahead of
 * its turbo apply window. A turbo can be earned only once per challenge, so an
 * earn held back now is one a later "Win Turbo" mission can still count. The
 * caller lifts the hold while such a mission is active.
 *
 * @param now - Unix timestamp in seconds
 */
const isTurboEarnSaved = (challenge: Challenge, now: number): boolean => {
    if (settings.getEffectiveSetting('missionSaveTurbos', null) !== true) return false;
    const challengeId = challenge.id?.toString?.() || '';
    return challenge.close_time - now > getEffectiveTurboTime(challengeId) + SAVED_TURBO_EARN_LEAD_SEC;
};

/**
 * Decides whether to apply a won Turbo to one of the user's entries.
 *
 * When `turboFillNew` is on the caller will submit a fresh photo and Turbo
 * that instead of an existing entry, so the "no entries" guard is relaxed
 * (fill-new can create the first entry) and `imageId` is returned only as a
 * fallback target for when the fresh submit can't happen.
 *
 * @param now - Unix timestamp in seconds
 * @param options - When `emergency` is true and the
 *   challenge is inside the Emergency Fill window, apply a won turbo regardless
 *   of the useTurbo toggle or the turboTime window.
 */
const shouldApplyTurbo = (challenge: Challenge, now: number, options: { emergency?: boolean } = {}): TurboDecision => {
    const noop = (reason: string): TurboDecision => ({ apply: false, imageId: null, fillNew: false, reason });
    if (!challenge) return noop('no challenge');
    if (challenge.close_time <= now) return noop('challenge ended');

    const challengeId = challenge.id?.toString?.() || '';

    // Emergency override: inside the Emergency Fill window, apply a won turbo
    // even when useTurbo is off — at the buzzer an unused turbo is wasted. The
    // turboTime threshold below is also skipped in this case (the challenge is
    // about to close).
    //
    // Turbo does not wait for an open boost window: the two are independent, and
    // the only rule between them — never on the same entry — is enforced by the
    // entry pick below (pickEntryAvoidingConflict).
    const emergency = options.emergency === true && isWithinEmergencyWindow(challenge, now);
    if (!emergency && !settings.getEffectiveSetting('useTurbo', challengeId)) return noop('useTurbo disabled');

    const turbo = challenge.member?.turbo || {};
    if (turbo.state !== 'WON') return noop(`turbo state ${turbo.state || 'unknown'}`);

    if (!emergency) {
        const effectiveTurboTime = getEffectiveTurboTime(challengeId);
        const timeUntilEnd = challenge.close_time - now;
        if (timeUntilEnd > effectiveTurboTime) {
            return noop(
                `${Math.floor(timeUntilEnd / 60)}m remaining > ${Math.floor(effectiveTurboTime / 60)}m threshold`,
            );
        }
    }

    const fillNew = settings.getEffectiveSetting('turboFillNew', challengeId) === true;
    // Narrower opt-in: fill a fresh photo ONLY to break a boost/turbo conflict
    // (the single existing entry already has Boost, so Turbo cannot go there).
    // `turboFillNew` (always) takes precedence and is handled first below.
    const fillNewOnConflict = settings.getEffectiveSetting('turboFillNewOnConflict', challengeId) === true;

    // Resolve the existing-entry pick. With fill-new on it is only the
    // fallback target (used when no fresh photo can be submitted), so an
    // empty/conflicting entry list is fine — fill-new creates a new entry.
    const entries = challenge.member?.ranking?.entries;
    const hasEntries = Array.isArray(entries) && entries.length > 0;
    const requestedIndex = settings.getEffectiveSetting('turboImageIndex', challengeId);
    const picked = hasEntries ? pickEntryAvoidingConflict(entries, requestedIndex, 'boosted') : null;
    const existingImageId = picked?.id || null;

    if (fillNew) {
        return { apply: true, imageId: existingImageId, fillNew: true, reason: 'eligible (fill-new)' };
    }

    if (!hasEntries) {
        return noop('no entries to apply turbo to');
    }
    if (!picked) {
        // The invariant (≤1 boost per challenge) means picker-null is only
        // reachable when entries.length === 1 and that entry has Boost.
        if (fillNewOnConflict) {
            // Submit and Turbo a fresh entry instead. imageId stays null: there
            // is no safe fallback target (the only existing entry is boosted), so
            // if the fresh submit can't happen the turbo runner skips this cycle
            // rather than turboing the boosted entry.
            return { apply: true, imageId: null, fillNew: true, reason: 'eligible (fill-new on conflict)' };
        }
        return noop('only entry already has Boost applied');
    }
    if (!existingImageId) return noop('selected entry has no id');
    return { apply: true, imageId: existingImageId, fillNew: false, reason: 'eligible' };
};

export {
    isWithinEmergencyWindow,
    shouldApplyBoost,
    getBoostHoldUntil,
    isBoostWindowOpen,
    shouldPlayAutoTurbo,
    isTurboEarnSaved,
    shouldApplyTurbo,
};
