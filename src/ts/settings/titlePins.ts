/**
 * Persisted first-seen challenge-title pins (the `titlePins.json` cache store,
 * `{ [id]: title }`): an internal, automatically-maintained cache that defeats
 * a server-side rename mid-challenge. It is a cache store beside the
 * configuration, not a part of it. Sole owner of the pin-cap warning latch.
 *
 * No IPC wiring — deliberate asymmetry with titleRules (which has a
 * user-facing editor).
 */

import * as logger from '../logger';
import { isPlainObject } from '../plainObject';
import { createJsonStore } from './storage';
import { MAX_TITLE_LENGTH } from './titleRuleSanitize';

const titlePinStore = createJsonStore({ fileName: 'titlePins.json', prefKey: 'gs_title_pins' });

// Defensive cap on the pin map size so an anomalously large challenge list
// can't bloat the cache store. Real active lists are tens of
// entries; 500 is far above anything GuruShots returns.
const MAX_TITLE_PINS = 500;

// One warning while the cap stays saturated (cleared once the map drops back
// under it) — an anomalous response would otherwise re-log every fetch cycle.
let titlePinCapWarned = false;

/**
 * Whether a value may be stored or restored as a pin. A whitespace-only value
 * would blank a real incoming title. A value at MAX_TITLE_LENGTH or longer is
 * rejected rather than truncated: stored pins exactly at that boundary may be
 * the prefix of a longer title and must never be restored as an exact match.
 */
const _isPinnableTitle = (title: unknown): title is string =>
    typeof title === 'string' && title.trim() !== '' && title.length < MAX_TITLE_LENGTH;

/**
 * Own-property copy of the valid pins in a stored map. Iterating own keys
 * means an id named `__proto__`/`constructor` can never surface a prototype
 * member; non-string / whitespace-only / over-length values a corrupted file
 * might carry are dropped.
 */
const _validPins = (stored: unknown): Record<string, string> => {
    const pins: Record<string, string> = {};
    if (isPlainObject(stored)) {
        for (const id of Object.keys(stored)) {
            const title = stored[id];
            if (_isPinnableTitle(title)) pins[id] = title;
        }
    }
    return pins;
};

// The parsed map of the last text read, so a lookup per setting read does not parse an unchanged file again.
let lastRaw: string | null = null;
let lastStored: unknown = null;

/**
 * The stored map as the file holds it. A file that is not readable JSON holds none.
 */
const _readStored = (): unknown => {
    const raw = titlePinStore.readRaw();
    if (raw === lastRaw) return lastStored;
    let parsed: unknown = null;
    try {
        parsed = raw === null ? null : JSON.parse(raw);
    } catch {
        // an unreadable cache holds no pins; the next merge rewrites it
    }
    lastRaw = raw;
    lastStored = parsed;
    return parsed;
};

/**
 * The valid pins in the store.
 */
const _readPins = (): Record<string, string> => _validPins(_readStored());

/**
 * Get the persisted first-seen challenge-title pins as `{ [id]: title }`.
 * Returns a defensive copy so callers can't mutate stored state around
 * mergeTitlePins' validation.
 */
const getTitlePins = (): Record<string, string> => _readPins();

/**
 * Every pin the store holds as a string, as stored (no pin is judged here: the readers do, each by its own rule), for the
 * mirror of the configuration to carry whole.
 */
const storedTitlePins = (): Record<string, string> => {
    const stored = _readStored();
    return isPlainObject(stored)
        ? Object.fromEntries(
              Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : {};
};

/**
 * The title pinned for one challenge id, or '' when there is none. A pin is a string below the title cap, as the
 * title lookup of a rule match has always read it (a whitespace-only one is a title that matches nothing).
 */
const pinnedTitleFor = (challengeId: string): string => {
    const stored = _readStored();
    if (!isPlainObject(stored) || !Object.hasOwn(stored, challengeId)) return '';
    const title = stored[challengeId];
    return typeof title === 'string' && title.length < MAX_TITLE_LENGTH ? title : '';
};

/**
 * The pinnable `[id, title]` entries of a caller-supplied adds map.
 */
const _addEntries = (adds: Record<string, string>): Array<[string, string]> =>
    adds && typeof adds === 'object' && !Array.isArray(adds)
        ? Object.entries(adds).filter((entry): entry is [string, string] => _isPinnableTitle(entry[1]))
        : [];

// Warn once per saturation that the pin cap blocked `id`. The id originates
// from the untrusted API response — strip CR/LF/tab and bound it before it
// reaches a log line (log-injection guard, same treatment as
// logger.challengeTag).
/** @param id */
const _warnPinCapOnce = (id: string) => {
    if (titlePinCapWarned) return;
    titlePinCapWarned = true;
    const safeId = id.replace(/[\r\n\t]/g, ' ').slice(0, 80);
    logger
        .withCategory('settings')
        .warning(`mergeTitlePins: pin cap of ${MAX_TITLE_PINS} reached — not pinning challenge ${safeId}`, null);
};

/**
 * Add each entry whose id has no pin yet (first-seen wins), stopping at the cap.
 */
const _addPins = (pins: Record<string, string>, addEntries: Array<[string, string]>) => {
    for (const [id, title] of addEntries) {
        if (Object.prototype.hasOwnProperty.call(pins, id)) continue;
        if (Object.keys(pins).length >= MAX_TITLE_PINS) {
            _warnPinCapOnce(id);
            return;
        }
        pins[id] = title;
    }
};

/**
 * Merge title pins into the persisted map — never a wholesale replace. Inside
 * the write the stored map is re-read; `adds` apply only to ids with no
 * existing pin (first-seen wins, so a concurrent writer's fresh pin is never
 * clobbered) and `removeIds` are deleted. Over-length titles are rejected
 * rather than truncated, preserving exact-match semantics. The map is capped.
 */
const mergeTitlePins = (adds: Record<string, string>, removeIds?: readonly string[]): boolean => {
    const addEntries = _addEntries(adds);
    const removeList = Array.isArray(removeIds) ? removeIds.filter((id) => typeof id === 'string') : [];
    if (addEntries.length === 0 && removeList.length === 0) return true;

    const pins = { ..._readPins() };
    for (const id of removeList) {
        delete pins[id];
    }
    _addPins(pins, addEntries);
    if (Object.keys(pins).length < MAX_TITLE_PINS) {
        titlePinCapWarned = false;
    }
    return _writePins(pins);
};

// Told after every write of the pins (the mirror of the configuration holds them: see persistence.ts).
let onWritten: (() => void) | null = null;

/** Sets the one listener that hears of every write of the pins. */
const onTitlePinsChange = (listener: (() => void) | null): void => {
    onWritten = listener;
};

const _writePins = (pins: Record<string, unknown>, notify = true): boolean => {
    try {
        titlePinStore.writeRaw(JSON.stringify(pins, null, 2));
    } catch (error) {
        logger.withCategory('settings').error('Could not save the title pins:', error);
        return false;
    }
    if (notify) onWritten?.();
    return true;
};

/**
 * Put the pins an import found into the cache, as it found them (every read validates what it takes): a pin the cache
 * holds for the same challenge gives way to the one `settings.json` held, which was seen first.
 *
 * @returns false when the store could not be written
 */
const importTitlePins = (imported: Record<string, string>): boolean => {
    const stored = _readStored();
    // Quietly: the configuration they belong to is not stored yet, and the mirror is made once it is.
    return _writePins({ ...(isPlainObject(stored) ? stored : {}), ...imported }, false);
};

/**
 * Forget every pin (a reset of the settings does, as it always has).
 *
 * @returns false when the store could not be written
 */
const clearTitlePins = (): boolean => _writePins({});

export {
    clearTitlePins,
    getTitlePins,
    importTitlePins,
    mergeTitlePins,
    onTitlePinsChange,
    pinnedTitleFor,
    storedTitlePins,
    titlePinStore,
    MAX_TITLE_PINS,
};
