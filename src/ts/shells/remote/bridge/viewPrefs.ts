/**
 * The phone-local view settings of the remote page: theme, language, the two compact
 * globals and the phone's own per-challenge compactCards overrides live in this device's
 * `localStorage` (`gs-remote-view-prefs`), never in the desktop's config.json. A change on
 * the phone does not reach the desktop; a desktop change to any of the four keys reaches
 * the phone only as a seed for keys that are still unset — a seed never overwrites, and a
 * failed desktop read passes through to the caller unchanged and stores nothing. An unset
 * global seeds itself through one forwarded read of the channel that answered it, and the
 * first effective read of an unseeded challenge rides with a read of the DESKTOP's global
 * default, so the rule/profile/phase classification compares against the desktop's own
 * baseline rather than the phone's.
 *
 * A challenge's compact value that comes from a desktop title rule, profile or scenario
 * phase is kept in `compactInherited`, not as an own override: only get-effective-setting
 * reads it, so the challenge does not show as customized and the card's first toggle
 * writes a real own override.
 *
 * One instance per bridge install (peer.ts hands it to apiSurface.ts and messages.ts), so
 * the routed window.api calls, the desktop's settings-changed events and the local events
 * a phone write dispatches all reach the same store. Loaded only by the remote renderer
 * entries, so it stays free of Node-side modules: the imports here are the dependency-free
 * core modules only. Every storage access is wrapped like core/remote/desktopVersion.ts —
 * a browser that refuses site data keeps the values in memory for the page's life.
 */

import { isPlainObject } from '../../../core/plainObject';
import { isUnsafeChallengeKey } from '../../../core/challengeKey';
import { THEMES } from '../../../core/settings/uiDefaults';
import { isSupportedLanguage } from '../../../core/translations/translator';

import type { PeerBridgeContext } from './context';
import type { InvokePipeline } from './invokes';

/** The `localStorage` key the phone's view settings are kept under. */
export const VIEW_PREFS_STORAGE = 'gs-remote-view-prefs';

/** The event channel a phone write dispatches to the bridge's own listeners. */
const SETTINGS_CHANNEL = 'settings-changed';

/** The most entries either per-challenge map keeps; extra stored entries are dropped on read. */
const MAP_CAP = 500;

/** One of the four view keys a phone write or a seed stores. */
type PrefKey = 'theme' | 'language' | 'compactCards' | 'compactCardActions';

/** The stored shape: the four globals plus the two per-challenge maps. */
type Stored = {
    theme?: string;
    language?: string;
    compactCards?: boolean;
    compactCardActions?: boolean;
    /** The phone's OWN per-challenge overrides; `null` = seeded: no own override. */
    compactOverrides: Record<string, boolean | null>;
    /** A compact value a desktop rule, profile or scenario phase gave the challenge at seed time. */
    compactInherited: Record<string, boolean>;
};

/** What the bridge's other pieces drive: the channel router and the desktop settings ingest. */
export type ViewPrefs = {
    /**
     * Answers the view-pref channels from the phone store; answers `null` = not one of them,
     * forward the call to the desktop unchanged.
     */
    route: (channel: string, args: unknown[]) => Promise<unknown> | null;
    /**
     * Remembers a desktop settings object (a get-settings answer or a settings-changed
     * payload), seeds the unset keys it carries, and answers the copy with the phone's
     * four keys in place.
     */
    ingestSettings: (payload: unknown) => unknown;
};

const THEME_SET: ReadonlySet<string> = new Set(THEMES);

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isStoredOverride = (value: unknown): value is boolean | null => value === null || typeof value === 'boolean';

/** What one seeding read settles with: the challenge's effective value and the desktop's global default. */
type SeedAnswers = [unknown, unknown];

export const createViewPrefs = ({
    ctx,
    sendInvoke,
}: {
    ctx: PeerBridgeContext;
    sendInvoke: InvokePipeline['sendInvoke'];
}): ViewPrefs => {
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
    const normalizeId = (challengeId: unknown): string => {
        if (typeof challengeId !== 'string' && typeof challengeId !== 'number') return '';
        const id = String(challengeId).trim();
        return id === '' || isUnsafeChallengeKey(id) ? '' : id;
    };

    /** The last desktop settings object the bridge saw; null before the first one. */
    let lastDesktop: Record<string, unknown> | null = null;

    /** The seeding reads in flight: one effective+global pair per id; concurrent invokes await the same promise. */
    const seedingReads = new Map<string, Promise<SeedAnswers>>();

    const emptyMaps = (): [Record<string, boolean | null>, Record<string, boolean>] => [
        Object.create(null) as Record<string, boolean | null>,
        Object.create(null) as Record<string, boolean>,
    ];

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

    // Parse once per page: the store lives in memory from here on, and each write updates
    // memory first, then storage.
    const storedRaw = attempt<string | null>(() => globalThis.localStorage?.getItem(VIEW_PREFS_STORAGE) ?? null, null);
    const store: Stored = storedRaw === null ? emptyStored() : parseStored(storedRaw);

    const persist = (): void => {
        attempt(() => globalThis.localStorage?.setItem(VIEW_PREFS_STORAGE, JSON.stringify(store)), undefined);
    };

    const mapFull = (map: Record<string, unknown>): boolean => Object.keys(map).length >= MAP_CAP;

    /**
     * Validates and stores one of the four globals. A seed (overwrite: false) skips a key the
     * phone already holds — a seed never overwrites, and a phone write made during a seed wins.
     */
    const putGlobal = (key: PrefKey, value: unknown, overwrite: boolean): boolean => {
        if (!overwrite && store[key] !== undefined) return false;
        if (key === 'theme') {
            if (typeof value !== 'string' || !THEME_SET.has(value)) return false;
            store.theme = value;
        } else if (key === 'language') {
            if (!isSupportedLanguage(value)) return false;
            store.language = value;
        } else if (key === 'compactCards') {
            if (typeof value !== 'boolean') return false;
            store.compactCards = value;
        } else {
            if (typeof value !== 'boolean') return false;
            store.compactCardActions = value;
        }
        return true;
    };

    /**
     * One of the four globals, seeded through the desktop on its first read: an unset key
     * forwards once, the answer seeds it, and the stored value is answered — or the desktop's
     * own answer when the seed stored nothing. A rejection or null answer passes through
     * unchanged and stores nothing; a seeded key never forwards.
     */
    const readGlobal = (key: PrefKey): Promise<unknown> => {
        const stored = store[key];
        if (stored !== undefined) return Promise.resolve(stored);
        const channel = key === 'theme' || key === 'language' ? 'get-setting' : 'get-global-default';
        return sendInvoke(channel, [key]).then((answer) => {
            if (putGlobal(key, answer, false)) persist();
            return store[key] ?? answer;
        });
    };

    /** Stores the phone's own override slot for one safe challenge id (a boolean, or null = none). */
    const storeOwn = (id: string, value: boolean | null): boolean => {
        if (!Object.hasOwn(store.compactOverrides, id) && mapFull(store.compactOverrides)) return false;
        store.compactOverrides[id] = value;
        persist();
        dispatchLocal();
        return true;
    };

    /** A phone write of the phone's own compactCards override; an invalid value answers false, as the desktop does. */
    const writeOwnOverride = (challengeId: unknown, value: unknown): boolean => {
        const id = normalizeId(challengeId);
        return id !== '' && isBoolean(value) ? storeOwn(id, value) : false;
    };

    /** remove-challenge-override: the phone's own override becomes "seeded: none". */
    const removeOwnOverride = (challengeId: unknown): boolean => {
        const id = normalizeId(challengeId);
        return id === '' ? false : storeOwn(id, null);
    };

    /** Seeds a challenge's own-override slot from a desktop value; a seed never overwrites, and the cap skips silently. */
    const seedOwn = (challengeId: unknown, desktopValue: unknown): boolean => {
        const id = normalizeId(challengeId);
        if (id === '' || Object.hasOwn(store.compactOverrides, id) || mapFull(store.compactOverrides)) return false;
        store.compactOverrides[id] = isBoolean(desktopValue) ? desktopValue : null;
        return true;
    };

    /** The phone's four keys over a desktop settings object: a copy, the desktop object untouched. */
    const overlaySettings = (payload: Record<string, unknown>): unknown => {
        const out: Record<string, unknown> = { ...payload };
        if (store.theme !== undefined || store.language !== undefined) {
            if (isPlainObject(payload.app)) {
                const app: Record<string, unknown> = { ...payload.app };
                if (store.theme !== undefined) app.theme = store.theme;
                if (store.language !== undefined) app.language = store.language;
                out.app = app;
            }
        }
        if (store.compactCards !== undefined || store.compactCardActions !== undefined) {
            if (isPlainObject(payload.defaults)) {
                const defaults: Record<string, unknown> = { ...payload.defaults };
                if (store.compactCards !== undefined) defaults.compactCards = store.compactCards;
                if (store.compactCardActions !== undefined) defaults.compactCardActions = store.compactCardActions;
                out.defaults = defaults;
            }
        }
        if (isPlainObject(payload.challenges)) {
            const challenges: Record<string, unknown> = { ...payload.challenges };
            for (const [key, record] of Object.entries(payload.challenges)) {
                const id = normalizeId(key);
                if (id === '' || !isPlainObject(record)) continue;
                const values = isPlainObject(record.values) ? record.values : undefined;
                const own = Object.hasOwn(store.compactOverrides, id) ? store.compactOverrides[id] : undefined;
                if (isBoolean(own)) {
                    // The phone's own override shows; a container the desktop payload lacks is created for it.
                    challenges[key] = { ...record, values: { ...(values ?? {}), compactCards: own } };
                } else if (values !== undefined && Object.hasOwn(values, 'compactCards')) {
                    // The phone has no own override: the key is left out — never `compactCards: null`,
                    // which would count the challenge as customized.
                    const next: Record<string, unknown> = { ...values };
                    delete next.compactCards;
                    challenges[key] = { ...record, values: next };
                }
            }
            out.challenges = challenges;
        }
        return out;
    };

    /** A phone write: the bridge's own listeners hear settings-changed with the phone's values in place. */
    const dispatchLocal = (): void => {
        const payload =
            lastDesktop === null
                ? { app: { theme: store.theme ?? null, language: store.language ?? null } }
                : overlaySettings(lastDesktop);
        for (const listener of ctx.listeners.get(SETTINGS_CHANNEL) ?? []) listener(payload);
    };

    /**
     * Classifies a seeding read's answers. A value that differs from the DESKTOP's own global
     * default — read in parallel with the effective value, never inferred from the phone's store —
     * was set by a rule, a profile or a scenario phase, so it is inherited, not an own override;
     * a value equal to the desktop baseline leaves only the null own-override seed. When either
     * read fails or answers a non-boolean, nothing at all is stored, and the next read tries again.
     */
    const classify = (id: string, answer: unknown, desktopGlobal: unknown): void => {
        if (!isBoolean(answer) || !isBoolean(desktopGlobal)) return;
        let changed = false;
        if (!Object.hasOwn(store.compactOverrides, id) && !mapFull(store.compactOverrides)) {
            store.compactOverrides[id] = null;
            changed = true;
        }
        if (store.compactOverrides[id] === null && answer !== desktopGlobal) {
            store.compactInherited[id] = answer;
            changed = true;
        }
        if (changed) persist();
    };

    /**
     * The answer an invoke that waited for the seeding read gets: the phone resolution
     * (own override, then inherited, then the phone global), with the desktop's own answer
     * as the fallback wherever the phone cannot resolve — a failed read, or a seeding pair
     * that classified nothing.
     */
    const resolutionAfterSeed = (id: string, answer: unknown, desktopGlobal: unknown): unknown => {
        const own = Object.hasOwn(store.compactOverrides, id) ? store.compactOverrides[id] : undefined;
        if (isBoolean(own)) return own; // the phone's own override wins, even over the fresh answer
        if (!isBoolean(answer) || !isBoolean(desktopGlobal)) return answer; // unclassified: the desktop answer passes
        if (Object.hasOwn(store.compactInherited, id)) return store.compactInherited[id];
        return store.compactCards ?? answer; // no inherited: the phone global applies; unseeded, the desktop answer passes
    };

    /**
     * get-effective-setting('compactCards', id): the first read of an unseeded id forwards ONE
     * seeding pair (single-flight per id — concurrent invokes await the same promise): the
     * effective value and, in parallel, the DESKTOP's global default to classify against.
     * Booleans seed the id; anything else passes through unchanged and stores nothing.
     */
    const seedingRead = (id: string): Promise<unknown> => {
        const answerOf = ([effective, desktopGlobal]: SeedAnswers): unknown =>
            resolutionAfterSeed(id, effective, desktopGlobal);
        const inFlight = seedingReads.get(id);
        if (inFlight !== undefined) return inFlight.then(answerOf);
        // sendInvoke directly, never route: routing the global default would seed it too, and the
        // classification needs the desktop's own baseline, not the phone's store.
        const read = Promise.all([
            sendInvoke('get-effective-setting', ['compactCards', id]),
            sendInvoke('get-global-default', ['compactCards']),
        ] as const).then(([effective, desktopGlobal]): SeedAnswers => {
            classify(id, effective, desktopGlobal);
            return [effective, desktopGlobal];
        });
        seedingReads.set(id, read);
        // The bookkeeping copy also absorbs the rejection, so it never reads as unhandled; the
        // map never replaces an in-flight entry, so the settled read's own slot is always the one to drop.
        const settle = (): void => {
            seedingReads.delete(id);
        };
        read.then(settle, settle);
        return read.then(answerOf);
    };

    const effectiveCompact = (args: unknown[]): Promise<unknown> => {
        const id = normalizeId(args[1]);
        if (id === '') return sendInvoke('get-effective-setting', args);
        const own = Object.hasOwn(store.compactOverrides, id) ? store.compactOverrides[id] : undefined;
        if (isBoolean(own)) return Promise.resolve(own);
        if (Object.hasOwn(store.compactInherited, id)) return Promise.resolve(store.compactInherited[id]);
        if (own === null) {
            // Already seeded as "no own override": the phone global applies — one forwarded read seeds it.
            return store.compactCards !== undefined ? Promise.resolve(store.compactCards) : readGlobal('compactCards');
        }
        return seedingRead(id);
    };

    /**
     * get-challenge-overrides(id): forwarded; the answer seeds the id's own-override slot, and the
     * phone's own value replaces `compactCards` — left out entirely when the phone has none.
     */
    const challengeOverridesRead = (challengeId: unknown): Promise<unknown> =>
        sendInvoke('get-challenge-overrides', [challengeId]).then((result) => {
            if (!isPlainObject(result)) return result;
            const changed = seedOwn(challengeId, Object.hasOwn(result, 'compactCards') ? result.compactCards : null);
            const id = normalizeId(challengeId);
            const own =
                id === '' || !Object.hasOwn(store.compactOverrides, id) ? undefined : store.compactOverrides[id];
            const out: Record<string, unknown> = { ...result };
            if (isBoolean(own)) out.compactCards = own;
            else delete out.compactCards;
            if (changed) persist();
            return out;
        });

    /**
     * replace-challenge-overrides(id, overrides, suppressed): the desktop keeps its own compactCards
     * entry (the form's value is a phone-local display flag), and the phone stores the form's value
     * only once the desktop accepted the replace — a failed or refused one leaves the phone value
     * unchanged. A desktop edit between the read and the replace can be undone by it; that race is
     * accepted for a display flag.
     */
    const replaceOverrides = (args: unknown[]): Promise<unknown> => {
        const id = normalizeId(args[0]);
        // An id the phone cannot key, or a form that is not an object, goes straight to the desktop:
        // it refuses both, the same false the composed path would answer.
        if (id === '' || !isPlainObject(args[1])) return sendInvoke('replace-challenge-overrides', args);
        const overrides: Record<string, unknown> = args[1];
        return sendInvoke('get-challenge-overrides', [args[0]]).then((desktop) => {
            if (!isPlainObject(desktop)) return false; // the desktop's own map is unknown: answer false, nothing was sent
            const composed: Record<string, unknown> = { ...overrides };
            if (Object.hasOwn(desktop, 'compactCards')) composed.compactCards = desktop.compactCards;
            else delete composed.compactCards;
            return sendInvoke('replace-challenge-overrides', [args[0], composed, args[2]]).then((accepted) => {
                if (accepted !== true) return accepted;
                const formValue: boolean | null = isBoolean(overrides.compactCards) ? overrides.compactCards : null;
                return storeOwn(id, formValue) ? true : false;
            });
        });
    };

    /**
     * get-settings-schema: forwarded; the two entries' defaults seed the globals, and the phone's
     * values replace theirs in the copy the phone sees.
     */
    const settingsSchemaRead = (): Promise<unknown> =>
        sendInvoke('get-settings-schema', []).then((result) => {
            if (!isPlainObject(result)) return result;
            let changed = false;
            for (const key of ['compactCards', 'compactCardActions'] as const) {
                const entry = result[key];
                if (putGlobal(key, isPlainObject(entry) ? entry.default : undefined, false)) changed = true;
            }
            const out: Record<string, unknown> = { ...result };
            for (const key of ['compactCards', 'compactCardActions'] as const) {
                const value = store[key];
                if (value === undefined || !isPlainObject(result[key])) continue;
                out[key] = { ...result[key], default: value };
            }
            if (changed) persist();
            return out;
        });

    /**
     * Drops the entries of challenges that are no longer active from both per-challenge maps
     * (compactOverrides and compactInherited); an empty or invalid list prunes nothing.
     */
    const pruneOverrides = (activeIds: unknown): void => {
        if (!Array.isArray(activeIds) || activeIds.length === 0) return;
        const keep = new Set<string>();
        for (const entry of activeIds) {
            const id = normalizeId(entry);
            if (id !== '') keep.add(id);
        }
        let changed = false;
        for (const id of Object.keys(store.compactOverrides)) {
            if (!keep.has(id)) {
                delete store.compactOverrides[id];
                changed = true;
            }
        }
        for (const id of Object.keys(store.compactInherited)) {
            if (!keep.has(id)) {
                delete store.compactInherited[id];
                changed = true;
            }
        }
        if (changed) persist();
    };

    /** Remembers a desktop settings object, seeds the unset keys it carries, and answers the overlaid copy. */
    const ingestSettings = (payload: unknown): unknown => {
        if (!isPlainObject(payload)) return payload;
        lastDesktop = payload;
        let changed = false;
        if (isPlainObject(payload.app)) {
            changed = putGlobal('theme', payload.app.theme, false) || changed;
            changed = putGlobal('language', payload.app.language, false) || changed;
        }
        if (isPlainObject(payload.defaults)) {
            changed = putGlobal('compactCards', payload.defaults.compactCards, false) || changed;
            changed = putGlobal('compactCardActions', payload.defaults.compactCardActions, false) || changed;
        }
        if (isPlainObject(payload.challenges)) {
            for (const [key, record] of Object.entries(payload.challenges)) {
                const values = isPlainObject(record) && isPlainObject(record.values) ? record.values : undefined;
                const desktop =
                    values !== undefined && Object.hasOwn(values, 'compactCards') ? values.compactCards : null;
                if (seedOwn(key, desktop)) changed = true;
            }
        }
        if (changed) persist();
        return overlaySettings(payload);
    };

    // Forwarded on purpose, with no renderer caller today: set-challenge-overrides, reset-setting,
    // is-setting-modified, save-settings, apply-challenge-profile. They reach the desktop's values —
    // a future caller of these writes or reads what the computer holds, not the phone's view keys.
    const route = (channel: string, args: unknown[]): Promise<unknown> | null => {
        switch (channel) {
            case 'get-setting': {
                const key = args[0];
                if (key !== 'theme' && key !== 'language') return null;
                return readGlobal(key);
            }
            case 'set-setting': {
                const key = args[0];
                if (key !== 'theme' && key !== 'language') return null;
                if (!putGlobal(key, args[1], true)) return Promise.resolve(false);
                persist();
                dispatchLocal();
                return Promise.resolve(true);
            }
            case 'get-global-default': {
                const key = args[0];
                if (key !== 'compactCards' && key !== 'compactCardActions') return null;
                return readGlobal(key);
            }
            case 'set-global-default': {
                const key = args[0];
                if (key !== 'compactCards' && key !== 'compactCardActions') return null;
                if (!putGlobal(key, args[1], true)) return Promise.resolve(false);
                persist();
                dispatchLocal();
                return Promise.resolve(true);
            }
            case 'get-effective-setting':
                if (args[0] !== 'compactCards') return null;
                return effectiveCompact(args);
            case 'get-challenge-override': {
                if (args[0] !== 'compactCards') return null;
                const id = normalizeId(args[1]);
                const own =
                    id === '' || !Object.hasOwn(store.compactOverrides, id) ? undefined : store.compactOverrides[id];
                return Promise.resolve(isBoolean(own) ? own : null);
            }
            case 'set-challenge-override':
                if (args[0] !== 'compactCards') return null;
                return Promise.resolve(writeOwnOverride(args[1], args[2]));
            case 'remove-challenge-override':
                if (args[0] !== 'compactCards') return null;
                return Promise.resolve(removeOwnOverride(args[1]));
            case 'get-challenge-overrides':
                return challengeOverridesRead(args[0]);
            case 'replace-challenge-overrides':
                return replaceOverrides(args);
            case 'get-settings':
                return sendInvoke('get-settings', args).then((result) =>
                    isPlainObject(result) ? ingestSettings(result) : result,
                );
            case 'get-settings-schema':
                return settingsSchemaRead();
            case 'cleanup-stale-challenge-setting':
            case 'cleanup-stale-metadata':
                pruneOverrides(args[0]);
                return null;
            default:
                return null;
        }
    };

    return { route, ingestSettings };
};
