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
// 0 = last / 1-4 = slot addressing, shared with the swap automation.
import { resolveEntryIndex } from '../../voting/entrySlot';
import { canStillFire, findPinnedEntry } from '../../voting/entryPins';

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
 * Pick the entry at the configured 1-indexed slot, falling back to the
 * entry one position earlier (wrapping past slot 0 to the last entry)
 * if the configured entry already has the conflicting action applied.
 *
 * GuruShots permits at most one turbo and one boost per challenge, on
 * different entries. So when boost is picking an entry it must avoid the
 * turboed one (conflictField='turbo'); when turbo is picking it must avoid
 * the boosted one (conflictField='boosted'). A single-step backward fallback
 * is always sufficient — unless the challenge has only one entry and that
 * one is already in the conflicting state, in which case returns null.
 *
 * `preferAvoidId` (the other feature's live pin) is a preference only: a
 * backward walk over every slot first skips the flagged entries AND that
 * photo; with no candidate left the pick runs again without the preference.
 * So a pin never strands a spend, and null still means exactly "every
 * candidate carries the conflicting flag".
 */
const pickEntryAvoidingConflict = (
    entries: readonly RankingEntry[] | null | undefined,
    requestedIndex: number | null | undefined,
    conflictField: 'turbo' | 'boosted',
    preferAvoidId?: string | null,
): RankingEntry | null => {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    // Non-empty array guaranteed above, so resolveEntryIndex returns a number.
    let slot = resolveEntryIndex(entries, requestedIndex) as number;
    if (preferAvoidId) {
        for (let step = 0; step < entries.length; step++) {
            const candidate = entries[(slot - step + entries.length) % entries.length];
            if (!candidate?.[conflictField] && String(candidate?.id) !== preferAvoidId) return candidate;
        }
    }
    if (entries[slot]?.[conflictField]) {
        slot = (slot - 1 + entries.length) % entries.length;
    }
    return entries[slot]?.[conflictField] ? null : entries[slot];
};

/**
 * Pick the entry a boost should land on: the photo pinned for Boost when it is usable, else
 * `boostImageIndex` (1-indexed, 0 = last), stepping off any entry that already carries turbo and,
 * when it can, the photo pinned for Turbo. Symmetric to shouldApplyTurbo's own pick, which
 * avoids boosted entries.
 *
 * Lives here rather than privately inside api/boost.ts so the mock boost surface resolves the
 * SAME entry the real one does. Both then raise the conflict flag on it, which is what keeps
 * the same-pass "boost and turbo never share an entry" rule true in mock mode too — the mock
 * runs the identical shared voting pass, so a rule that only held on the real surface would
 * make mock runs quietly diverge.
 *
 * @returns the entry to boost, or null when every candidate is turboed
 */
const pickBoostEntry = (challenge: Challenge, challengeId: string): RankingEntry | null => {
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const pin = resolvePin(challenge, challengeId, 'boost');
    if (pin.state === 'hit') return pin.entry;
    const requestedIndex = settings.getEffectiveSetting('boostImageIndex', challengeId);
    return pickEntryAvoidingConflict(entries, requestedIndex, 'turbo', livePinnedId(challenge, challengeId, 'turbo'));
};

/**
 * Resolves how a boost should source its target entry for a challenge:
 * - `'always'`  — `boostFillNew` is on: always submit a fresh photo and boost it.
 * - `'conflict'` — `boostFillNewOnConflict` is on AND the only existing entry is
 *   already turboed (so Boost cannot be placed on any existing entry): submit a
 *   fresh photo purely to break that boost/turbo conflict.
 * - `'no'` — boost an existing entry the normal way (always the case while the photo pinned
 *   for Boost is usable: the pin names the target).
 *
 * `boostFillNew` (always) takes precedence over `boostFillNewOnConflict`, and the
 * conflict mode only engages when the conflict actually exists — mirroring the
 * `!picked` branch in {@link shouldApplyTurbo}, where picker-null with at least
 * one entry means the single entry carries the other feature's flag.
 */
const resolveBoostFillNewMode = (challenge: Challenge, challengeId: string): 'always' | 'conflict' | 'no' => {
    if (resolvePin(challenge, challengeId, 'boost').state === 'hit') return 'no';
    if (settings.getEffectiveSetting('boostFillNew', challengeId) === true) return 'always';
    if (settings.getEffectiveSetting('boostFillNewOnConflict', challengeId) === true) {
        const entries = challenge?.member?.ranking?.entries;
        if (Array.isArray(entries) && entries.length >= 1 && pickBoostEntry(challenge, challengeId) === null) {
            return 'conflict';
        }
    }
    return 'no';
};

export {
    pickEntryAvoidingConflict,
    pickBoostEntry,
    resolveBoostFillNewMode,
    resolvePin,
    livePinnedId,
    livePinnedIds,
    pinFallbackOf,
    describePinFallback,
};
