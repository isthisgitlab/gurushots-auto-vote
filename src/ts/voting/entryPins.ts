import type { Challenge, RankingEntry } from '../types/gurushots';
import type { EntryPinKind, EntryPins } from '../types/settings';
/**
 * How a pinned photo (settings/entryPins) reads against a challenge's current
 * entries. Pure and dependency-free, so the Node-side picks
 * (services/decisions/entryPick) and the renderer's pin controls answer
 * "is this pin usable?" identically.
 */

/**
 * The pin's state on one challenge. `hit` carries the LIVE entry, so a stored
 * pin string never reaches a boost or turbo request; `gone` = the photo is no
 * longer an entry; `conflict` = it carries the other feature's flag.
 */
type PinResolution = { state: 'none' | 'gone' | 'conflict' } | { state: 'hit'; entry: RankingEntry };

// The flag that stops a feature landing on an entry: the OTHER feature's.
const CONFLICT_FIELD = { boost: 'turbo', turbo: 'boosted' } as const;

/**
 * Match the photo pinned for `kind` against the challenge's current entries.
 * Ids compare as strings. The entries are matched afresh on every call: the
 * server reorders them between polls, so a position never names a photo.
 *
 * @param pinnedId - the stored pin (null = no pin)
 */
const findPinnedEntry = (challenge: Challenge, kind: EntryPinKind, pinnedId: string | null): PinResolution => {
    if (pinnedId === null) return { state: 'none' };
    const entries = challenge?.member?.ranking?.entries;
    const entry = Array.isArray(entries) ? entries.find((candidate) => String(candidate?.id) === pinnedId) : undefined;
    if (!entry) return { state: 'gone' };
    return entry[CONFLICT_FIELD[kind]] ? { state: 'conflict' } : { state: 'hit', entry };
};

/** Why a feature can never fire on a challenge: its type has no such feature, or it has one photo slot. */
type NeverFiresReason = 'flash' | 'single-photo' | 'exhibition';

/**
 * Why `kind` can never fire on the challenge, or null. Boost has no flash challenge and never unlocks on a
 * single-photo one (its state stays LOCKED for the whole challenge); Turbo has neither flash nor exhibition.
 * Shared with the renderer's settings applicability, so the two never disagree.
 */
const featureNeverFires = (challenge: Challenge, kind: EntryPinKind): NeverFiresReason | null => {
    if (challenge?.type === 'flash') return 'flash';
    if (kind === 'boost') return challenge?.max_photo_submits === 1 ? 'single-photo' : null;
    return challenge?.type === 'exhibition' ? 'exhibition' : null;
};

/**
 * Whether `kind` can still be spent on the challenge: the challenge type allows it, no entry carries it yet
 * and its state is neither USED nor UNAVAILABLE. LOCKED and MISSED Boosts and
 * LOCKED, FREE and TIMER Turbos still count — a key or a mini-game can open them.
 */
const canStillFire = (challenge: Challenge, kind: EntryPinKind): boolean => {
    if (featureNeverFires(challenge, kind)) return false;
    const state = challenge?.member?.[kind]?.state;
    if (state === 'USED' || state === 'UNAVAILABLE') return false;
    const spentFlag = kind === 'boost' ? 'boosted' : 'turbo';
    const entries = challenge?.member?.ranking?.entries;
    return !(Array.isArray(entries) && entries.some((entry) => entry?.[spentFlag]));
};

/**
 * The stored pins that cannot take their feature right now — the photo left the challenge (`gone`) or carries
 * the other feature (`conflict`) — while the feature can still fire. A spent feature's pin is inert, so it is
 * not listed.
 */
const unusablePins = (challenge: Challenge, pins: EntryPins): { kind: EntryPinKind; state: 'gone' | 'conflict' }[] =>
    (['boost', 'turbo'] as const).flatMap((kind) => {
        const { state } = findPinnedEntry(challenge, kind, pins[kind]);
        return (state === 'gone' || state === 'conflict') && canStillFire(challenge, kind) ? [{ kind, state }] : [];
    });

/**
 * The feature `entry` is live-pinned for, or null: the stored pin names it, it
 * does not carry the other feature's flag and the feature can still fire. A
 * spent feature's pin is inert, so it shows and protects nothing.
 */
const livePinKindOf = (challenge: Challenge, entry: RankingEntry, pins: EntryPins): EntryPinKind | null =>
    (['boost', 'turbo'] as const).find(
        (kind) => pins[kind] === String(entry.id) && !entry[CONFLICT_FIELD[kind]] && canStillFire(challenge, kind),
    ) ?? null;

export { findPinnedEntry, canStillFire, featureNeverFires, unusablePins, livePinKindOf };
export type { PinResolution, NeverFiresReason };
