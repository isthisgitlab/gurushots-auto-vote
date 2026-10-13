/**
 * The photo a challenge's Boost and Turbo are pinned to
 * (`challengeSettings.entryPins`, `{ [challengeId]: { boost?, turbo? } }`).
 *
 * A sibling container rather than two per-challenge schema settings: an image
 * id means nothing in a profile, a scenario phase or the per-challenge modal,
 * and a pin alone must not mark a challenge as customised. Sole owner of the
 * pin-cap warning latch.
 */

import * as logger from '../logger';
import { oneLine } from '../format/logSafe';
import { isUnsafeChallengeKey } from '../metadata/validation';
import { isPlainObject } from '../plainObject';
import { loadSettings, saveSettings } from './persistence';

import type { EntryPinKind, EntryPinRecord, EntryPins } from '../types/settings';

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

const _isPinnableId = (value: unknown): value is string => typeof value === 'string' && IMAGE_ID_PATTERN.test(value);

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
        if (_isPinnableId(imageId)) record[kind] = imageId;
    }
    return record;
};

/**
 * Own-property copy of the valid records in a stored map (never a prototype
 * member, whatever the ids are named).
 */
const _validMap = (stored: Record<string, unknown>): Record<string, EntryPinRecord> => {
    const map: Record<string, EntryPinRecord> = {};
    for (const id of Object.keys(stored)) {
        const record = _validRecord(stored[id]);
        if (_keyOf(id) !== null && Object.keys(record).length > 0) map[id] = record;
    }
    return map;
};

/**
 * The photos pinned for a challenge's Boost and Turbo (null = no pin). Reads
 * the one record only: this runs per challenge on every voting pass.
 */
const getEntryPins = (challengeId: string | number): EntryPins => {
    const key = _keyOf(challengeId);
    // loadSettings has already replaced a container that is not a plain object with the empty default.
    const stored: Record<string, unknown> = loadSettings().challengeSettings.entryPins;
    const record = key !== null && Object.hasOwn(stored, key) ? _validRecord(stored[key]) : {};
    return { boost: record.boost ?? null, turbo: record.turbo ?? null };
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
 * Pin a photo for a challenge's Boost or Turbo, or clear the pin (`imageId`
 * null). A photo is never pinned for both: pinning it for one feature clears
 * the other feature's pin on it. An empty record is dropped.
 *
 * @returns false when the arguments are refused, the cap blocks a new
 *   challenge, or the write fails
 */
const setEntryPin = (kind: EntryPinKind, challengeId: string | number, imageId: string | null): boolean => {
    const key = _keyOf(challengeId);
    if (!_isKind(kind) || key === null || (imageId !== null && !_isPinnableId(imageId))) return false;

    const settings = loadSettings();
    const pins = _validMap(settings.challengeSettings.entryPins);
    const known = Object.hasOwn(pins, key);
    const next: EntryPinRecord = { ...(known ? pins[key] : {}) };
    if (imageId === null) {
        delete next[kind];
    } else {
        next[kind] = imageId;
        const other = kind === 'boost' ? 'turbo' : 'boost';
        if (next[other] === imageId) delete next[other];
    }

    if (Object.keys(next).length === 0) {
        delete pins[key];
    } else {
        if (!known && Object.keys(pins).length >= MAX_ENTRY_PINS) {
            _warnPinCapOnce(key);
            return false;
        }
        pins[key] = next;
    }
    if (Object.keys(pins).length < MAX_ENTRY_PINS) entryPinCapWarned = false;

    settings.challengeSettings.entryPins = pins;
    return saveSettings(settings);
};

export { getEntryPins, setEntryPin, MAX_ENTRY_PINS };
