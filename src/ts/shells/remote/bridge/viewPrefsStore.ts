/**
 * The store of the phone-local view settings: the four globals and the two per-challenge
 * maps, parsed once per page from this device's `localStorage` (`gs-remote-view-prefs`)
 * and written back through one persist. Every field is validated on read — an invalid one
 * is dropped and counts as unseeded — and on write, and every storage access is wrapped so
 * a browser that refuses site data keeps the values in memory for the page's life. The
 * factory builds fresh state per viewPrefs instance, never module-level singletons. Loaded
 * only by the remote renderer entries, so it stays free of Node-side modules: the imports
 * are the dependency-free core modules only.
 */

import { isPlainObject } from '../../../core/plainObject';
import { isUnsafeChallengeKey } from '../../../core/challengeKey';
import { THEMES } from '../../../core/settings/uiDefaults';
import { isSupportedLanguage } from '../../../core/translations/translator';

/** The `localStorage` key the phone's view settings are kept under. */
export const VIEW_PREFS_STORAGE = 'gs-remote-view-prefs';

/** The most entries either per-challenge map keeps; extra stored entries are dropped on read. */
const MAP_CAP = 500;

/** One of the four view keys a phone write or a seed stores. */
export type PrefKey = 'theme' | 'language' | 'compactCards' | 'compactCardActions';

/** The stored shape: the four globals plus the two per-challenge maps. */
export type Stored = {
    theme?: string;
    language?: string;
    compactCards?: boolean;
    compactCardActions?: boolean;
    /** The phone's OWN per-challenge overrides; `null` = seeded: no own override. */
    compactOverrides: Record<string, boolean | null>;
    /** A compact value a desktop rule, profile or scenario phase gave the challenge at seed time. */
    compactInherited: Record<string, boolean>;
};

/** What the viewPrefs router drives on its store: the values, the writes and the persistence. */
export type ViewPrefsStore = {
    /** The in-memory store, parsed once when the factory runs. */
    stored: Stored;
    /** Writes the store to localStorage; a browser that refuses site data keeps memory only. */
    persist: () => void;
    /** True while a per-challenge map has no free slot for a new id. */
    mapFull: (map: Record<string, unknown>) => boolean;
    /**
     * Validates and stores one of the four globals. A seed (overwrite: false) skips a key the
     * phone already holds — a seed never overwrites, and a phone write made during a seed wins.
     */
    putGlobal: (key: PrefKey, value: unknown, overwrite: boolean) => boolean;
};

const THEME_SET: ReadonlySet<string> = new Set(THEMES);

export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isStoredOverride = (value: unknown): value is boolean | null => value === null || typeof value === 'boolean';

/** Runs a storage action; a browser that refuses site data keeps nothing, which only costs the persistence. */
const attempt = <T>(action: () => T, fallback: T): T => {
    try {
        return action();
    } catch {
        return fallback;
    }
};

/**
 * Trimmed string form of a caller-supplied challenge id ('' when absent, or when it names an
 * Object.prototype member rather than a challenge) — the only form a store map is keyed by.
 */
export const normalizeId = (challengeId: unknown): string => {
    if (typeof challengeId !== 'string' && typeof challengeId !== 'number') return '';
    const id = String(challengeId).trim();
    return id === '' || isUnsafeChallengeKey(id) ? '' : id;
};

/** Keeps the valid entries of a stored map, safe ids only, at most MAP_CAP of them. */
const readMap = <V>(value: unknown, keep: (entry: unknown) => entry is V): Record<string, V> => {
    const map = Object.create(null) as Record<string, V>;
    if (!isPlainObject(value)) return map;
    let kept = 0;
    for (const [key, entry] of Object.entries(value)) {
        if (kept >= MAP_CAP) break;
        const id = normalizeId(key);
        if (id === '' || !keep(entry)) continue;
        map[id] = entry;
        kept += 1;
    }
    return map;
};

const emptyMaps = (): [Record<string, boolean | null>, Record<string, boolean>] => [
    Object.create(null) as Record<string, boolean | null>,
    Object.create(null) as Record<string, boolean>,
];

const emptyStored = (): Stored => {
    const [compactOverrides, compactInherited] = emptyMaps();
    return { compactOverrides, compactInherited };
};

/** Field-by-field: an invalid field is dropped and counts as unseeded. */
const parseStored = (raw: string): Stored => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return emptyStored();
    }
    if (!isPlainObject(parsed)) return emptyStored();
    const stored = emptyStored();
    if (typeof parsed.theme === 'string' && THEME_SET.has(parsed.theme)) stored.theme = parsed.theme;
    if (isSupportedLanguage(parsed.language)) stored.language = parsed.language;
    if (typeof parsed.compactCards === 'boolean') stored.compactCards = parsed.compactCards;
    if (typeof parsed.compactCardActions === 'boolean') stored.compactCardActions = parsed.compactCardActions;
    stored.compactOverrides = readMap(parsed.compactOverrides, isStoredOverride);
    stored.compactInherited = readMap(parsed.compactInherited, isBoolean);
    return stored;
};

export const createViewPrefsStore = (): ViewPrefsStore => {
    // Parse once per page: the store lives in memory from here on, and each write updates
    // memory first, then storage.
    const storedRaw = attempt<string | null>(() => globalThis.localStorage?.getItem(VIEW_PREFS_STORAGE) ?? null, null);
    const stored: Stored = storedRaw === null ? emptyStored() : parseStored(storedRaw);

    const persist = (): void => {
        attempt(() => globalThis.localStorage?.setItem(VIEW_PREFS_STORAGE, JSON.stringify(stored)), undefined);
    };

    const mapFull = (map: Record<string, unknown>): boolean => Object.keys(map).length >= MAP_CAP;

    const putGlobal = (key: PrefKey, value: unknown, overwrite: boolean): boolean => {
        if (!overwrite && stored[key] !== undefined) return false;
        if (key === 'theme') {
            if (typeof value !== 'string' || !THEME_SET.has(value)) return false;
            stored.theme = value;
        } else if (key === 'language') {
            if (!isSupportedLanguage(value)) return false;
            stored.language = value;
        } else if (key === 'compactCards') {
            if (!isBoolean(value)) return false;
            stored.compactCards = value;
        } else {
            if (!isBoolean(value)) return false;
            stored.compactCardActions = value;
        }
        return true;
    };

    return { stored, persist, mapFull, putGlobal };
};

/**
 * Drops the entries of challenges that are no longer active from both per-challenge maps
 * (compactOverrides and compactInherited); an empty or invalid list prunes nothing. Answers
 * whether anything was removed, so the caller persists only then.
 */
export const pruneOverrides = (stored: Stored, activeIds: unknown): boolean => {
    if (!Array.isArray(activeIds) || activeIds.length === 0) return false;
    const keep = new Set<string>();
    for (const entry of activeIds) {
        const id = normalizeId(entry);
        if (id !== '') keep.add(id);
    }
    let changed = false;
    for (const id of Object.keys(stored.compactOverrides)) {
        if (!keep.has(id)) {
            delete stored.compactOverrides[id];
            changed = true;
        }
    }
    for (const id of Object.keys(stored.compactInherited)) {
        if (!keep.has(id)) {
            delete stored.compactInherited[id];
            changed = true;
        }
    }
    return changed;
};
