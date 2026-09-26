/**
 * Persisted first-seen challenge-title pins (`challengeSettings.titlePins`,
 * `{ [id]: title }`): an internal, automatically-maintained cache that defeats
 * a server-side rename mid-challenge. Sole owner of the pin-cap warning latch.
 *
 * No IPC wiring — deliberate asymmetry with titleRules (which has a
 * user-facing editor).
 */

import * as logger from '../logger';
import { loadSettings, saveSettings } from './persistence';
import { ensureChallengeSettings } from './defaults';
import { MAX_TITLE_LENGTH } from './titleRuleSanitize';

// Defensive cap on the pin map size so an anomalously large challenge list
// can't bloat the shared settings blob. Real active lists are tens of
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
 *
 * @param {unknown} title
 * @returns {title is string}
 */
const _isPinnableTitle = (title) => typeof title === 'string' && title.trim() !== '' && title.length < MAX_TITLE_LENGTH;

/**
 * Own-property copy of the valid pins in a stored map. Iterating own keys
 * means an id named `__proto__`/`constructor` can never surface a prototype
 * member; non-string / whitespace-only / over-length values a corrupted blob
 * might carry are dropped.
 *
 * @param {unknown} stored
 * @returns {Record<string, string>}
 */
const _validPins = (stored) => {
    /** @type {Record<string, string>} */
    const pins = {};
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        const map = /** @type {Record<string, unknown>} */ (stored);
        for (const id of Object.keys(map)) {
            const title = map[id];
            if (_isPinnableTitle(title)) pins[id] = title;
        }
    }
    return pins;
};

/**
 * Get the persisted first-seen challenge-title pins as `{ [id]: title }`.
 * Returns a defensive copy so callers can't mutate stored state around
 * mergeTitlePins' validation.
 *
 * @returns {Record<string, string>}
 */
const getTitlePins = () => _validPins(loadSettings().challengeSettings?.titlePins);

/**
 * The pinnable `[id, title]` entries of a caller-supplied adds map.
 *
 * @param {unknown} adds
 * @returns {Array<[string, string]>}
 */
const _addEntries = (adds) =>
    adds && typeof adds === 'object' && !Array.isArray(adds)
        ? Object.entries(adds).filter(/** @returns {entry is [string, string]} */ (entry) => _isPinnableTitle(entry[1]))
        : [];

// Warn once per saturation that the pin cap blocked `id`. The id originates
// from the untrusted API response — strip CR/LF/tab and bound it before it
// reaches a log line (log-injection guard, same treatment as
// logger.challengeTag).
/** @param {string} id */
const _warnPinCapOnce = (id) => {
    if (titlePinCapWarned) return;
    titlePinCapWarned = true;
    const safeId = String(id)
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, 80);
    logger
        .withCategory('settings')
        .warning(`mergeTitlePins: pin cap of ${MAX_TITLE_PINS} reached — not pinning challenge ${safeId}`, null);
};

/**
 * Add each entry whose id has no pin yet (first-seen wins), stopping at the cap.
 *
 * @param {Record<string, string>} pins
 * @param {Array<[string, string]>} addEntries
 */
const _addPins = (pins, addEntries) => {
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
 *
 * @param {unknown} adds
 * @param {unknown} removeIds
 * @returns {boolean}
 */
const mergeTitlePins = (adds, removeIds) => {
    const addEntries = _addEntries(adds);
    const removeList = Array.isArray(removeIds) ? removeIds.filter((id) => typeof id === 'string') : [];
    if (addEntries.length === 0 && removeList.length === 0) return true;

    const settings = loadSettings();
    const challengeSettings = ensureChallengeSettings(settings);
    const pins = _validPins(challengeSettings.titlePins);
    for (const id of removeList) {
        delete pins[id];
    }
    _addPins(pins, addEntries);
    if (Object.keys(pins).length < MAX_TITLE_PINS) {
        titlePinCapWarned = false;
    }

    challengeSettings.titlePins = pins;
    return saveSettings(settings);
};

export { getTitlePins, mergeTitlePins };
