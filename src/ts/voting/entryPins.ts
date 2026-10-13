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

/**
 * Whether `kind` can still be spent on the challenge: no entry carries it yet
 * and its state is neither USED nor UNAVAILABLE. LOCKED and MISSED Boosts and
 * LOCKED, FREE and TIMER Turbos still count — a key or a mini-game can open them.
 */
const canStillFire = (challenge: Challenge, kind: EntryPinKind): boolean => {
    const state = challenge?.member?.[kind]?.state;
    if (state === 'USED' || state === 'UNAVAILABLE') return false;
    const spentFlag = kind === 'boost' ? 'boosted' : 'turbo';
    const entries = challenge?.member?.ranking?.entries;
    return !(Array.isArray(entries) && entries.some((entry) => entry?.[spentFlag]));
};

/**
 * The feature `entry` is live-pinned for, or null: the stored pin names it, it
 * does not carry the other feature's flag and the feature can still fire. A
 * spent feature's pin is inert, so it shows and protects nothing.
 */
const livePinKindOf = (challenge: Challenge, entry: RankingEntry, pins: EntryPins): EntryPinKind | null =>
    (['boost', 'turbo'] as const).find(
        (kind) => pins[kind] === String(entry.id) && !entry[CONFLICT_FIELD[kind]] && canStillFire(challenge, kind),
    ) ?? null;

export { findPinnedEntry, canStillFire, livePinKindOf };
export type { PinResolution };
