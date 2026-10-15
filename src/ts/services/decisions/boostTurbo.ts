import type { Challenge } from '../../types/gurushots';
/**
 * Boost and turbo apply decisions, including the Emergency Fill override.
 * Part of the services/VotingLogic facade.
 */

import * as settings from '../../settings';
import { isBoostWindowOpen as boostWindowOpen } from '../../voting/boostWindow';
import { getEffectiveBoostTime, getEffectiveKeyUnlockedBoostTime, getEffectiveTurboTime } from './thresholds';
import { isWithinEmergencyWindow, pickTurboEntry, resolvePin, resolveTurboFillNewMode } from './entryPick';

interface TurboDecision {
    apply: boolean;
    imageId: string | null;
    fillNew: boolean;
    reason: string;
    /** The target is the photo pinned for Turbo (the user's explicit choice). */
    pinned?: true;
    /** A pin exists but is unusable, so the pick fell back to the slot rules. */
    pinFallback?: 'gone' | 'conflict';
}

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

    // In the emergency window the boostTime threshold does not matter (the
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
 * True when a free boost should be applied now for a "Use a boost" mission: the
 * challenge is open, its boost is usable right now (never a LOCKED one, so no
 * key is spent), Auto-Apply Boost is on for it, the mission still needs one and
 * the window setting of the kind of boost on offer is not 0 (off), as in
 * shouldApplyBoost. Only pulls the timing of shouldApplyBoost forward.
 * @param now - Unix timestamp in seconds
 * @param boostNeed - boosts the mission still needs
 */
const isBoostDueForMission = (challenge: Challenge, now: number, boostNeed: number): boolean => {
    if (boostNeed <= 0 || challenge.close_time <= now || !isBoostWindowOpen(challenge, now)) return false;
    const challengeId = challenge.id.toString();
    if (!settings.getEffectiveSetting('autoBoost', challengeId)) return false;
    // The open window leaves two kinds: a running timer, else key-unlocked (as in shouldApplyBoost).
    const timeout = challenge.member?.boost?.timeout;
    const isTimerBased = challenge.member?.boost?.state === 'AVAILABLE' && typeof timeout === 'number' && timeout > 0;
    return (isTimerBased ? getEffectiveBoostTime(challengeId) : getEffectiveKeyUnlockedBoostTime(challengeId)) > 0;
};

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
 * A usable pinned photo is the target and beats both fill-new modes; an unusable
 * pin (gone, or already boosted) falls back to the rules below and is reported
 * as `pinFallback`. The slot pick never lands on the photo pinned for Boost while that
 * pin is live (pickTurboEntry); with every candidate taken, `turboFillNewOnConflict`
 * submits a fresh photo, else the turbo is skipped. Once that pin has given way, a fresh photo is
 * still preferred and the pinned one is the target only when nothing else can take the turbo.
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
    // entry pick below (pickTurboEntry).
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

    const pin = resolvePin(challenge, challengeId, 'turbo');
    if (pin.state === 'hit') {
        return {
            apply: true,
            imageId: String(pin.entry.id),
            fillNew: false,
            pinned: true,
            reason: 'eligible (pinned)',
        };
    }
    const pinFallback = pin.state === 'gone' || pin.state === 'conflict' ? pin.state : undefined;
    const applyWith = (decision: TurboDecision): TurboDecision =>
        pinFallback ? { ...decision, pinFallback } : decision;

    // The pick and the fill-new mode (Manual Photos Only turns both fresh-photo options off) are
    // shared with the deadline view, so the two never disagree on what a Turbo does.
    const fillMode = resolveTurboFillNewMode(challenge, challengeId);
    // With fill-new on, an existing entry is only the fallback target (used when no fresh photo can be
    // submitted), so an empty/conflicting entry list is fine — fill-new creates a new entry.
    const picked = pickTurboEntry(challenge, challengeId, now);
    const existingImageId = picked?.id || null;

    if (fillMode === 'always') {
        return applyWith({ apply: true, imageId: existingImageId, fillNew: true, reason: 'eligible (fill-new)' });
    }
    if (fillMode === 'conflict') {
        // Every entry has Boost or is pinned for Boost: submit and Turbo a fresh entry instead. The
        // fallback target is the photo pinned for Boost once that pin has given way, else null — then
        // there is no safe one, and if the fresh submit can't happen the turbo runner skips this cycle
        // rather than turboing the boosted or pinned entry.
        return applyWith({
            apply: true,
            imageId: existingImageId,
            fillNew: true,
            reason: 'eligible (fill-new on conflict)',
        });
    }

    const entries = challenge.member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        return noop('no entries to apply turbo to');
    }
    if (!picked) return noop('every entry has Boost or is pinned for Boost');
    if (!existingImageId) return noop('selected entry has no id');
    return applyWith({ apply: true, imageId: existingImageId, fillNew: false, reason: 'eligible' });
};

export {
    shouldApplyBoost,
    getBoostHoldUntil,
    isBoostWindowOpen,
    isBoostDueForMission,
    shouldPlayAutoTurbo,
    isTurboEarnSaved,
    shouldApplyTurbo,
};
