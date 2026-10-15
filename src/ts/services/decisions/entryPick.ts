import type { Challenge, RankingEntry } from '../../types/gurushots';
import type { EntryPinKind } from '../../types/settings';
import type { PinResolution } from '../../voting/entryPins';
/**
 * Boost/turbo entry selection: which entry a boost or turbo lands on, never
 * sharing one, how a pinned photo overrides the slot pick, and how a boost
 * sources its entry when every candidate is taken. Part of the
 * services/VotingLogic facade.
 */

import * as settings from '../../settings';
import { boostDeadline, isBoostWindowOpen } from '../../voting/boostWindow';
// 0 = last / 1-4 = slot addressing, shared with the swap automation.
import { resolveEntryIndex } from '../../voting/entrySlot';
import { canStillFire, findPinnedEntry } from '../../voting/entryPins';
import { isManualPhotosOnly } from '../manualPhotosOnly';

/**
 * Resolve the photo pinned for `kind` against the challenge's current entries.
 */
const resolvePin = (challenge: Challenge, challengeId: string, kind: EntryPinKind): PinResolution =>
    findPinnedEntry(challenge, kind, settings.getEntryPins(challengeId)[kind]);

/**
 * The photo pinned for `kind` while the pin is live — usable, and its feature
 * can still fire — else null. A spent feature's pin is inert: it no longer
 * steers the other feature or protects the photo from auto-swap.
 */
const livePinnedId = (challenge: Challenge, challengeId: string, kind: EntryPinKind): string | null => {
    const pin = resolvePin(challenge, challengeId, kind);
    return pin.state === 'hit' && canStillFire(challenge, kind) ? String(pin.entry.id) : null;
};

/**
 * Both features' live pin ids on a challenge (the photos auto-swap leaves alone).
 */
const livePinnedIds = (challenge: Challenge, challengeId: string): string[] =>
    (['boost', 'turbo'] as const)
        .map((kind) => livePinnedId(challenge, challengeId, kind))
        .filter((id): id is string => id !== null);

/**
 * True when the per-challenge Emergency Fill window is enabled (> 0) and
 * `secondsLeft` — seconds to a deadline — is inside it.
 */
const isInsideEmergencyWindow = (challengeId: string, secondsLeft: number): boolean => {
    const emergencySeconds = settings.getEffectiveSetting('emergencyFill', challengeId);
    if (!Number.isFinite(emergencySeconds) || emergencySeconds <= 0) return false;
    return secondsLeft > 0 && secondsLeft <= emergencySeconds;
};

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
    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return false;
    return isInsideEmergencyWindow(challenge.id?.toString?.() || '', closeTime - now);
};

/**
 * A live pin held against the other feature's spend: the photo's id, and when the pin gives way.
 */
type PinBlock = { id: string; releaseAt: number | null };

/**
 * Whether the photo pinned for `kind` blocks the OTHER feature's spend, and until when. It blocks
 * while its feature can still fire (livePinnedId), a Turbo not won yet included. It gives way once
 * the blocked spend is within Emergency Fill seconds of its own deadline (the boost's timeout or
 * the close for a Boost; the close for a Turbo) and the pinned feature still is not ready (Turbo
 * WON, Boost window open) — that spend lands rather than being wasted. A ready pin, or Emergency
 * Fill off (0), never gives way.
 *
 * @param kind - the feature the photo is pinned for
 * @param now - Unix timestamp in seconds
 * @returns null when no live pin blocks; `releaseAt` is null when the pin never gives way
 */
const pinBlockOf = (challenge: Challenge, challengeId: string, kind: EntryPinKind, now: number): PinBlock | null => {
    const id = livePinnedId(challenge, challengeId, kind);
    if (id === null) return null;
    const ready =
        kind === 'turbo' ? challenge?.member?.turbo?.state === 'WON' : isBoostWindowOpen(challenge?.member?.boost, now);
    const emergencySeconds = settings.getEffectiveSetting('emergencyFill', challengeId);
    // A pin for Turbo blocks a Boost, so the deadline is the boost's; a pin for Boost blocks a Turbo.
    const deadline = kind === 'turbo' ? boostDeadline(challenge) : Number(challenge?.close_time);
    if (ready || !Number.isFinite(emergencySeconds) || emergencySeconds <= 0 || !Number.isFinite(deadline)) {
        return { id, releaseAt: null };
    }
    if (isInsideEmergencyWindow(challengeId, deadline - now)) return null;
    const releaseAt = deadline - emergencySeconds;
    return { id, releaseAt: releaseAt > now ? releaseAt : null };
};

/**
 * The photo pinned for `kind` while it blocks the other feature, else null (see pinBlockOf).
 */
const blockingPinnedId = (challenge: Challenge, challengeId: string, kind: EntryPinKind, now: number): string | null =>
    pinBlockOf(challenge, challengeId, kind, now)?.id ?? null;

/**
 * The instant the photo pinned for `kind` stops blocking the other feature (Unix seconds), or null
 * when it is not blocking or never gives way.
 */
const pinReleaseAt = (challenge: Challenge, challengeId: string, kind: EntryPinKind, now: number): number | null =>
    pinBlockOf(challenge, challengeId, kind, now)?.releaseAt ?? null;

/**
 * Why a pin did not decide the pick: `gone` / `conflict`, or null with no pin
 * or a usable one. For the apply log line of a spend that fell back to the slot pick.
 */
const pinFallbackOf = (challenge: Challenge, challengeId: string, kind: EntryPinKind): 'gone' | 'conflict' | null => {
    const { state } = resolvePin(challenge, challengeId, kind);
    return state === 'gone' || state === 'conflict' ? state : null;
};

/**
 * Log wording for a pin that fell back to the slot pick.
 */
const describePinFallback = (kind: EntryPinKind, fallback: 'gone' | 'conflict'): string =>
    fallback === 'gone'
        ? `pinned photo isn't in the challenge right now — using the usual ${kind} settings`
        : `pinned photo already has ${kind === 'boost' ? 'Turbo' : 'Boost'} — using the usual ${kind} settings`;

/**
 * Pick the entry at the configured 1-indexed slot, walking backward (wrapping past
 * slot 0 to the last entry) to the first one that carries neither the conflicting
 * action nor the avoided photo.
 *
 * GuruShots permits at most one turbo and one boost per challenge, on
 * different entries. So when boost is picking an entry it must avoid the
 * turboed one (conflictField='turbo'); when turbo is picking it must avoid
 * the boosted one (conflictField='boosted'). `avoidId` is the photo the other
 * feature is pinned to (blockingPinnedId): it is as unavailable as a flagged one.
 * Null means every entry is flagged or avoided. A live pin is inert once any entry
 * carries the other feature's flag, so a flag and a live pin never coexist: only a
 * single flagged entry, or a single entry pinned for the other feature, leaves no
 * candidate — which a fill-new mode resolves.
 */
const pickEntryAvoidingConflict = (
    entries: readonly RankingEntry[] | null | undefined,
    requestedIndex: number | null | undefined,
    conflictField: 'turbo' | 'boosted',
    avoidId?: string | null,
): RankingEntry | null => {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    // Non-empty array guaranteed above, so resolveEntryIndex returns a number.
    const slot = resolveEntryIndex(entries, requestedIndex) as number;
    for (let step = 0; step < entries.length; step++) {
        const candidate = entries[(slot - step + entries.length) % entries.length];
        if (!candidate?.[conflictField] && String(candidate?.id) !== avoidId) return candidate;
    }
    return null;
};

/**
 * Pick the entry a boost should land on: the photo pinned for Boost when it is usable, else
 * `boostImageIndex` (1-indexed, 0 = last), stepping off any entry that already carries turbo and
 * off the photo pinned for Turbo while that pin blocks (blockingPinnedId). Symmetric to
 * pickTurboEntry, which avoids boosted entries.
 *
 * Lives here rather than privately inside api/boost.ts so the mock boost surface resolves the
 * SAME entry the real one does. Both then raise the conflict flag on it, which is what keeps
 * the same-pass "boost and turbo never share an entry" rule true in mock mode too — the mock
 * runs the identical shared voting pass, so a rule that only held on the real surface would
 * make mock runs quietly diverge.
 *
 * @param now - Unix timestamp in seconds
 * @returns the entry to boost, or null when every candidate is turboed or pinned for Turbo
 */
const pickBoostEntry = (challenge: Challenge, challengeId: string, now: number): RankingEntry | null => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const pin = resolvePin(challenge, challengeId, 'boost');
    if (pin.state === 'hit') return pin.entry;
    const requestedIndex = settings.getEffectiveSetting('boostImageIndex', challengeId);
    return pickEntryAvoidingConflict(
        entries,
        requestedIndex,
        'turbo',
        blockingPinnedId(challenge, challengeId, 'turbo', now),
    );
};

/**
 * Resolves how a boost should source its target entry for a challenge:
 * - `'always'`  — `boostFillNew` is on: always submit a fresh photo and boost it.
 * - `'conflict'` — `boostFillNewOnConflict` is on AND every existing entry is
 *   turboed or pinned for Turbo (so Boost cannot be placed on any existing entry):
 *   submit a fresh photo purely to break that boost/turbo conflict.
 * - `'no'` — boost an existing entry the normal way (always the case while the photo pinned
 *   for Boost is usable: the pin names the target, and while Manual Photos Only is on: no
 *   fresh photo is ever submitted by itself).
 *
 * `boostFillNew` (always) takes precedence over `boostFillNewOnConflict`, and the
 * conflict mode only engages when the conflict actually exists — mirroring
 * {@link resolveTurboFillNewMode}.
 *
 * @param now - Unix timestamp in seconds
 */
const resolveBoostFillNewMode = (
    challenge: Challenge,
    challengeId: string,
    now: number,
): 'always' | 'conflict' | 'no' => {
    if (isManualPhotosOnly(settings, challengeId)) return 'no';
    if (resolvePin(challenge, challengeId, 'boost').state === 'hit') return 'no';
    if (settings.getEffectiveSetting('boostFillNew', challengeId) === true) return 'always';
    if (settings.getEffectiveSetting('boostFillNewOnConflict', challengeId) === true) {
        const entries = challenge?.member?.ranking?.entries;
        if (Array.isArray(entries) && entries.length >= 1 && pickBoostEntry(challenge, challengeId, now) === null) {
            return 'conflict';
        }
    }
    return 'no';
};

/**
 * Pick the entry a won Turbo should land on: the photo pinned for Turbo when it is usable, else
 * `turboImageIndex`, stepping off any entry that already carries boost and off the photo pinned
 * for Boost while that pin blocks (blockingPinnedId). Mirror of {@link pickBoostEntry}.
 *
 * @param now - Unix timestamp in seconds
 * @returns the entry to turbo, or null when every candidate is boosted or pinned for Boost
 */
const pickTurboEntry = (challenge: Challenge, challengeId: string, now: number): RankingEntry | null => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const pin = resolvePin(challenge, challengeId, 'turbo');
    if (pin.state === 'hit') return pin.entry;
    const requestedIndex = settings.getEffectiveSetting('turboImageIndex', challengeId);
    return pickEntryAvoidingConflict(
        entries,
        requestedIndex,
        'boosted',
        blockingPinnedId(challenge, challengeId, 'boost', now),
    );
};

/**
 * How a Turbo sources its target entry — {@link resolveBoostFillNewMode}'s mirror, with
 * `turboFillNew` / `turboFillNewOnConflict`, and the conflict being every entry boosted or pinned for Boost.
 *
 * @param now - Unix timestamp in seconds
 */
const resolveTurboFillNewMode = (
    challenge: Challenge,
    challengeId: string,
    now: number,
): 'always' | 'conflict' | 'no' => {
    if (isManualPhotosOnly(settings, challengeId)) return 'no';
    if (resolvePin(challenge, challengeId, 'turbo').state === 'hit') return 'no';
    if (settings.getEffectiveSetting('turboFillNew', challengeId) === true) return 'always';
    if (settings.getEffectiveSetting('turboFillNewOnConflict', challengeId) === true) {
        const entries = challenge?.member?.ranking?.entries;
        if (Array.isArray(entries) && entries.length >= 1 && pickTurboEntry(challenge, challengeId, now) === null) {
            return 'conflict';
        }
    }
    return 'no';
};

export {
    pickEntryAvoidingConflict,
    pickBoostEntry,
    resolveBoostFillNewMode,
    pickTurboEntry,
    resolveTurboFillNewMode,
    resolvePin,
    livePinnedId,
    livePinnedIds,
    blockingPinnedId,
    pinReleaseAt,
    isWithinEmergencyWindow,
    pinFallbackOf,
    describePinFallback,
};
