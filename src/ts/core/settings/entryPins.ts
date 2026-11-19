/**
 * The photo a challenge's Boost and Turbo are pinned to
 * (`challenges[id].pins`, `{ boost?, turbo? }`).
 *
 * A sibling field of a challenge's record rather than two per-challenge schema settings: an image
 * id means nothing in a profile, a scenario phase or the per-challenge modal,
 * and a pin alone must not mark a challenge as customised. Sole owner of the
 * pin-cap warning latch.
 */

import * as logger from '../logger';
import { oneLine } from '../format/logSafe';
import { isUnsafeChallengeKey } from '../challengeKey';
import { isPlainObject } from '../plainObject';
import { applyPinToRecord } from '../voting/entryPins';
import { SCENARIO_CAPS, isPoolIds, isPoolName } from '../scenarios/vocabulary';
import { loadSettings, saveSettings, updateSettings } from './persistence';

import type { ConfigV2 } from '../types/config';
import type { EntryPinKind, EntryPinRecord, EntryPinResult, EntryPins } from '../types/settings';

// Defensive cap on the map size, like the title pins': real active lists are
// tens of challenges.
const MAX_ENTRY_PINS = 500;

// Real image ids are 32-character hex and mock ids look like `entry_007`; the
// charset also keeps a stored id out of log-injection territory.
const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const KINDS: readonly EntryPinKind[] = ['boost', 'turbo'];

// One warning while the cap stays saturated (cleared once the map drops back under it).
let entryPinCapWarned = false;

const _isKind = (kind: unknown): kind is EntryPinKind => kind === 'boost' || kind === 'turbo';

/**
 * Whether `value` is an image id a pin may name: letters, digits, `_` and `-`, 1 to 64 characters. The one place
 * the pattern lives, for the facade's own checks and for callers that check an id before they log or send it.
 */
const isPinnableImageId = (value: unknown): value is string =>
    typeof value === 'string' && IMAGE_ID_PATTERN.test(value);

/**
 * The map key for a challenge id, or null when the id may not address a pin
 * (blank, or a name that reaches Object.prototype).
 */
const _keyOf = (challengeId: unknown): string | null => {
    if (typeof challengeId !== 'string' && typeof challengeId !== 'number') return null;
    const key = String(challengeId).trim();
    return key === '' || isUnsafeChallengeKey(key) ? null : key;
};

/**
 * An own-property copy of the valid pins in one stored record: a hand-edited
 * file or a raw save-settings write can carry anything.
 */
const _validRecord = (stored: unknown): EntryPinRecord => {
    const record: EntryPinRecord = {};
    if (!isPlainObject(stored)) return record;
    for (const kind of KINDS) {
        const imageId = Object.hasOwn(stored, kind) ? stored[kind] : undefined;
        if (isPinnableImageId(imageId)) record[kind] = imageId;
    }
    return record;
};

/**
 * Own-property copy of the valid pin records of every challenge (never a prototype
 * member, whatever the ids are named).
 */
const _validMap = (challenges: ConfigV2['challenges']): Record<string, EntryPinRecord> => {
    const map: Record<string, EntryPinRecord> = {};
    for (const id of Object.keys(challenges)) {
        const record = _validRecord(challenges[id].pins);
        if (_keyOf(id) !== null && Object.keys(record).length > 0) map[id] = record;
    }
    return map;
};

/**
 * The photos pinned for a challenge's Boost and Turbo (null = no pin), as the user saved them: what the pin controls show
 * and write. Reads the one record only: this runs per challenge on every voting pass.
 */
const getEntryPins = (challengeId: string | number): EntryPins => {
    const key = _keyOf(challengeId);
    // loadSettings has already replaced a container that is not a plain object with the empty default, and a
    // challenge record that is not an object is gone.
    const { challenges } = loadSettings();
    const record = key !== null && Object.hasOwn(challenges, key) ? _validRecord(challenges[key].pins) : {};
    return { boost: record.boost ?? null, turbo: record.turbo ?? null };
};

/** The pins one scenario tier sets: a photo id, null for no pin whatever the lower tiers say, absent to inherit. */
type PinTier = { boost?: string | null; turbo?: string | null };

/**
 * The pins in force: for each power the highest tier that sets it — the runtime pin of the phase entry, the phase's pin, the
 * saved pin; a missing value inherits, an explicit null suppresses. A photo is pinned for one power only: when both end
 * on the same photo, the power whose pin comes from the lower tier gives it up (the saved pins' own rule, applyPinToRecord).
 * Pure: it writes nothing, so a tier above never overwrites the saved pin.
 */
const mergeEntryPins = (stored: EntryPins, phase?: PinTier, runtime?: PinTier): EntryPins => {
    const pick = (kind: EntryPinKind): { id: string | null; rank: number } => {
        if (runtime?.[kind] !== undefined) return { id: runtime[kind], rank: 3 };
        if (phase?.[kind] !== undefined) return { id: phase[kind], rank: 2 };
        return { id: stored[kind], rank: 1 };
    };
    const boost = pick('boost');
    const turbo = pick('turbo');
    const same = boost.id !== null && boost.id === turbo.id && boost.rank !== turbo.rank;
    return {
        boost: same && boost.rank < turbo.rank ? null : boost.id,
        turbo: same && turbo.rank < boost.rank ? null : turbo.id,
    };
};

/** What writing a photo pool came to: refused as malformed, the cap of pools reached, a name taken (create only), or the write failing. */
type PhotoPoolResult = 'ok' | 'invalid' | 'cap' | 'exists' | 'write-failed';

/** The account's named photo pools: pool name to its photo ids, in order. A copy. */
const getPhotoPools = (): Record<string, string[]> => structuredClone(loadSettings().photoPools ?? {});

/**
 * Changes the account's photo pools in one durable configuration change: `change` gets the pools as they are stored when
 * the write is made (not as an earlier read saw them), and answers the pools to keep or why it refuses (nothing is then
 * written). Every pool writer goes through here, so none writes back a pool map it loaded before another writer's change.
 */
const updatePhotoPools = <Refusal extends string>(
    change: (pools: Record<string, string[]>) => { pools: Record<string, string[]> } | { refused: Refusal },
): Refusal | 'ok' | 'write-failed' => {
    let refusal: Refusal | null = null;
    const saved = updateSettings((current) => {
        const made = change({ ...current.photoPools });
        if ('refused' in made) {
            refusal = made.refused;
            return null;
        }
        return { photoPools: made.pools };
    });
    if (refusal !== null) return refusal;
    return saved ? 'ok' : 'write-failed';
};

/**
 * Saves a named photo pool (the ordered photo ids a scenario phase draws from), replacing the pool of that name. A name or
 * a list that is malformed (see vocabulary isPoolName / isPoolIds) is refused, and so is a new pool past the cap. A scenario's
 * progress with the pool is its own ledger's; it is never touched here.
 */
const setPhotoPool = (name: string, ids: readonly string[]): PhotoPoolResult => {
    if (!isPoolName(name) || !isPoolIds(ids)) return 'invalid';
    return updatePhotoPools<'cap'>((pools) =>
        !Object.hasOwn(pools, name) && Object.keys(pools).length >= SCENARIO_CAPS.photoPools
            ? { refused: 'cap' }
            : { pools: { ...pools, [name]: [...ids] } },
    );
};

/**
 * Creates a named photo pool, and never replaces one: a name another pool holds (compared without regard to case) is
 * refused (`exists`) on the pools as they are stored when the write is made, so a pool another scenario draws from is left
 * as it is. Binding to an existing pool is the picker's job, not this call's. Otherwise as setPhotoPool.
 */
const createPhotoPool = (name: string, ids: readonly string[]): PhotoPoolResult => {
    if (!isPoolName(name) || !isPoolIds(ids)) return 'invalid';
    return updatePhotoPools<'cap' | 'exists'>((pools) => {
        if (Object.keys(pools).some((saved) => saved.toLowerCase() === name.toLowerCase()))
            return { refused: 'exists' };
        return Object.keys(pools).length >= SCENARIO_CAPS.photoPools
            ? { refused: 'cap' }
            : { pools: { ...pools, [name]: [...ids] } };
    });
};

// Warn once per saturation that the cap blocked `key`.
const _warnPinCapOnce = (key: string) => {
    if (entryPinCapWarned) return;
    entryPinCapWarned = true;
    logger
        .withCategory('settings')
        .warning(`setEntryPin: pin cap of ${MAX_ENTRY_PINS} reached — not pinning challenge ${oneLine(key)}`, null);
};

/**
 * Puts the pin records onto the challenge records: a challenge that has none loses its `pins`, and a record that holds
 * nothing is dropped.
 */
const _storePins = (settings: ConfigV2, pins: Record<string, EntryPinRecord>) => {
    for (const id of Object.keys(settings.challenges)) {
        if (Object.hasOwn(pins, id)) continue;
        delete settings.challenges[id].pins;
        if (Object.keys(settings.challenges[id]).length === 0) delete settings.challenges[id];
    }
    for (const [id, record] of Object.entries(pins)) {
        if (!Object.hasOwn(settings.challenges, id)) settings.challenges[id] = {};
        settings.challenges[id].pins = record;
    }
};

/**
 * Pin a photo for a challenge's Boost or Turbo, or clear the pin (`imageId`
 * null). A photo is never pinned for both: pinning it for one feature clears
 * the other feature's pin on it. An empty record is dropped.
 *
 * @returns which of `ok`, a refused argument, the cap blocking a new
 *   challenge, or a failed write it was
 */
const setEntryPin = (kind: EntryPinKind, challengeId: string | number, imageId: string | null): EntryPinResult => {
    const key = _keyOf(challengeId);
    if (!_isKind(kind) || key === null || (imageId !== null && !isPinnableImageId(imageId))) return 'invalid';

    const settings = loadSettings();
    const pins = _validMap(settings.challenges);
    const known = Object.hasOwn(pins, key);
    // Clearing a pin that was never set changes nothing: no write, no broadcast.
    if (imageId === null && (!known || pins[key][kind] === undefined)) return 'ok';
    const next: EntryPinRecord = { ...(known ? pins[key] : {}) };
    applyPinToRecord(next, kind, imageId);

    if (Object.keys(next).length === 0) {
        delete pins[key];
    } else {
        if (!known && Object.keys(pins).length >= MAX_ENTRY_PINS) {
            _warnPinCapOnce(key);
            return 'cap';
        }
        pins[key] = next;
    }
    if (Object.keys(pins).length < MAX_ENTRY_PINS) entryPinCapWarned = false;

    _storePins(settings, pins);
    return saveSettings(settings) ? 'ok' : 'write-failed';
};

export {
    getEntryPins,
    mergeEntryPins,
    setEntryPin,
    isPinnableImageId,
    getPhotoPools,
    setPhotoPool,
    createPhotoPool,
    updatePhotoPools,
    MAX_ENTRY_PINS,
};
