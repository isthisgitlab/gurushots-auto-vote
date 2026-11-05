/**
 * The phone-local view settings of the remote page: theme, language, the two compact
 * globals and the phone's own per-challenge compactCards overrides live in this device's
 * `localStorage` (`gs-remote-view-prefs`), never in the desktop's config.json. A change on
 * the phone does not reach the desktop; a desktop change to any of the four keys reaches
 * the phone only as a seed for keys that are still unset — a seed never overwrites, and a
 * failed desktop read passes through to the caller unchanged and stores nothing. An unset
 * global seeds itself through one forwarded read of the channel that answered it.
 *
 * Every challenge id is seeded by ONE combined single-flight seed: the overrides read, the
 * effective read and the DESKTOP's global default are forwarded together and the storage
 * decision runs from all three answers — a desktop own override becomes the phone's own, a
 * value that differs from the desktop's baseline was set by a rule, profile or scenario
 * phase and is inherited (kept in `compactInherited`, so only get-effective-setting reads
 * it, the challenge does not show as customized, and the card's first toggle writes a real
 * own override), and anything that fails or answers a non-boolean stores nothing, so the
 * next read runs the seed again.
 *
 * One instance per bridge install (peer.ts hands it to apiSurface.ts and messages.ts), so
 * the routed window.api calls, the desktop's settings-changed events and the local events
 * a phone write dispatches all reach the same store (viewPrefsStore.ts, overlaid by
 * viewPrefsOverlay.ts). Loaded only by the remote renderer entries, so it stays free of
 * Node-side modules: the imports are the dependency-free core modules only.
 */

import { isPlainObject } from '../../../core/plainObject';

import { createViewPrefsStore, isBoolean, normalizeId, pruneOverrides, VIEW_PREFS_STORAGE } from './viewPrefsStore';
import { overlaySettings } from './viewPrefsOverlay';

import type { PeerBridgeContext } from './context';
import type { InvokePipeline } from './invokes';
import type { PrefKey, ViewPrefsStore } from './viewPrefsStore';

export { VIEW_PREFS_STORAGE };

/** The event channel a phone write dispatches to the bridge's own listeners. */
const SETTINGS_CHANNEL = 'settings-changed';

/** One forwarded read's settled outcome: the fulfilled value, or its rejection. */
type SettledRead = { status: 'fulfilled'; value: unknown } | { status: 'rejected'; error: unknown };

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

/** What one seed settles with: the three forwarded reads, each its own settled outcome. */
type SeedOutcome = {
    overrides: SettledRead;
    effective: SettledRead;
    global: SettledRead;
};

export const createViewPrefs = ({
    ctx,
    sendInvoke,
}: {
    ctx: PeerBridgeContext;
    sendInvoke: InvokePipeline['sendInvoke'];
}): ViewPrefs => {
    const prefsStore: ViewPrefsStore = createViewPrefsStore();
    const { stored: store, persist, mapFull, putGlobal } = prefsStore;

    /** The last desktop settings object the bridge saw; null before the first one. */
    let lastDesktop: Record<string, unknown> | null = null;

    /** The seeds in flight: one combined three-read seed per id; concurrent invokes await the same promise. */
    const seeds = new Map<string, Promise<SeedOutcome>>();

    /** One of the four globals, seeded through the desktop on its first read: an unset key
     * forwards once, the answer seeds it, and the stored value is answered — or the desktop's
     * own answer when the seed stored nothing. A seeded key never forwards. */
    const readGlobal = (key: PrefKey): Promise<unknown> => {
        const held = store[key];
        if (held !== undefined) return Promise.resolve(held);
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

    /** Before any desktop object is known, the local event carries ONLY the keys the phone
     * holds (`{ app: {} }` when neither is): the renderer skips an absent key and keeps its
     * current value, while a `null` language would switch the phone to English. */
    const localApp = (): Record<string, unknown> => {
        const app: Record<string, unknown> = {};
        if (store.theme !== undefined) app.theme = store.theme;
        if (store.language !== undefined) app.language = store.language;
        return app;
    };

    /** A phone write: the bridge's own listeners hear settings-changed with the phone's values in place. */
    const dispatchLocal = (): void => {
        const payload = lastDesktop === null ? { app: localApp() } : overlaySettings(store, lastDesktop);
        for (const listener of ctx.listeners.get(SETTINGS_CHANNEL) ?? []) listener(payload);
    };

    /** Settles one forwarded read so a rejection in it can never fail the seed as a whole. */
    const settled = (read: Promise<unknown>): Promise<SettledRead> =>
        read.then(
            (value): SettledRead => ({ status: 'fulfilled', value }),
            (error: unknown): SettledRead => ({ status: 'rejected', error }),
        );

    /**
     * The seed's storage decision, run once all three reads have settled and consulted against
     * the store at that moment, so a phone write made while the seed was in flight wins. A
     * desktop own override (a boolean `compactCards` in the overrides answer) becomes the
     * phone's OWN override; an answer without one classifies against the DESKTOP's global
     * default — a different effective value was set by a rule, profile or scenario phase and
     * is inherited, an equal one leaves only the null own-override seed; every other case —
     * any rejection, a non-object overrides answer, a non-boolean effective or global answer —
     * stores NOTHING, and the next read runs the seed again. A seed never overwrites: a held
     * id is skipped entirely, and each map takes a new id only while a slot is free.
     */
    const storeSeed = (id: string, { overrides, effective, global }: SeedOutcome): boolean => {
        if (Object.hasOwn(store.compactOverrides, id) || Object.hasOwn(store.compactInherited, id)) return false;
        if (
            overrides.status === 'fulfilled' &&
            isPlainObject(overrides.value) &&
            isBoolean(overrides.value.compactCards)
        ) {
            if (mapFull(store.compactOverrides)) return false;
            store.compactOverrides[id] = overrides.value.compactCards;
            return true;
        }
        if (
            overrides.status === 'fulfilled' &&
            isPlainObject(overrides.value) &&
            effective.status === 'fulfilled' &&
            isBoolean(effective.value) &&
            global.status === 'fulfilled' &&
            isBoolean(global.value)
        ) {
            const inherits = effective.value !== global.value;
            // All or nothing: a rule value with no free inherited slot stores nothing, so the
            // forwarded answer passes through instead of a none-seed that would lose it for good.
            if (mapFull(store.compactOverrides) || (inherits && mapFull(store.compactInherited))) return false;
            store.compactOverrides[id] = null;
            if (inherits) store.compactInherited[id] = effective.value;
            return true;
        }
        return false;
    };

    /**
     * ONE combined single-flight seed per challenge id: the overrides read (the raw first
     * argument), the effective read (the normalized id) and the DESKTOP's global default are
     * forwarded together — sendInvoke directly, never route, since routing the global default
     * would answer the phone's store — and the storage decision runs once all three have
     * settled. Concurrent invokes await the same promise; a seed that stored nothing is
     * dropped on settle, so the next read runs it again. The resolved seed keeps the three
     * settled outcomes, so each channel can pass its own result through when nothing stored.
     */
    const seedChallenge = (rawId: unknown, id: string): Promise<SeedOutcome> => {
        const inFlight = seeds.get(id);
        if (inFlight !== undefined) return inFlight;
        const read: Promise<SeedOutcome> = Promise.all([
            settled(sendInvoke('get-challenge-overrides', [rawId])),
            settled(sendInvoke('get-effective-setting', ['compactCards', id])),
            settled(sendInvoke('get-global-default', ['compactCards'])),
        ]).then(([overrides, effective, global]): SeedOutcome => {
            const outcome: SeedOutcome = { overrides, effective, global };
            if (storeSeed(id, outcome)) persist();
            return outcome;
        });
        seeds.set(id, read);
        // The bookkeeping copy also absorbs any rejection, so it never reads as unhandled; the
        // map never replaces an in-flight entry, so the settled read's own slot is always the one to drop.
        const settle = (): void => {
            seeds.delete(id);
        };
        read.then(settle, settle);
        return read;
    };

    /** The local answer for one held id: the own override when boolean, else the inherited slot
     * when present, else the phone global — seeded through readGlobal when unset (a forwarded
     * read that is correct and expected). */
    const heldResolution = (id: string, own: boolean | null): Promise<unknown> => {
        if (isBoolean(own)) return Promise.resolve(own);
        if (Object.hasOwn(store.compactInherited, id)) return Promise.resolve(store.compactInherited[id]);
        return store.compactCards !== undefined ? Promise.resolve(store.compactCards) : readGlobal('compactCards');
    };

    /** The forwarded read's own settled outcome, passed to the caller as it arrived. */
    const passSettled = (settledRead: SettledRead): Promise<unknown> =>
        settledRead.status === 'fulfilled' ? Promise.resolve(settledRead.value) : Promise.reject(settledRead.error);

    /** get-effective-setting('compactCards', id): a held id answers locally with no desktop
     * call; an unheld one runs the seed first and answers locally when the seed held the id,
     * or passes the forwarded effective answer through unchanged when the seed stored nothing. */
    const effectiveCompact = (args: unknown[]): Promise<unknown> => {
        const id = normalizeId(args[1]);
        if (id === '') return sendInvoke('get-effective-setting', args);
        const own = Object.hasOwn(store.compactOverrides, id) ? store.compactOverrides[id] : undefined;
        // An id held in either map (a restored store can hold only the inherited one) answers locally.
        if (own !== undefined || Object.hasOwn(store.compactInherited, id)) {
            return heldResolution(id, own ?? null);
        }
        return seedChallenge(args[1], id).then((outcome) => {
            const ownAfter = Object.hasOwn(store.compactOverrides, id) ? store.compactOverrides[id] : undefined;
            if (ownAfter !== undefined) return heldResolution(id, ownAfter);
            return passSettled(outcome.effective);
        });
    };

    /** The forwarded overrides answer as the phone sees it: the phone's own value in place — the key
     * left out entirely when the phone has none (never `compactCards: null`, which would count the
     * challenge as customized); a rejection or a non-object answer passes through unchanged. */
    const withPhoneOwn = (id: string, result: unknown): unknown => {
        if (!isPlainObject(result)) return result;
        const own = Object.hasOwn(store.compactOverrides, id) ? store.compactOverrides[id] : undefined;
        const out: Record<string, unknown> = { ...result };
        if (isBoolean(own)) out.compactCards = own;
        else delete out.compactCards;
        return out;
    };

    /** get-challenge-overrides(id): a held id (and one the phone cannot key, never seeded)
     * forwards and answers the copy with the phone's own value in place; an unheld id runs the
     * seed first and passes the forwarded answer through unchanged when the seed stored nothing.
     * A rejected overrides read passes its rejection to the caller. */
    const challengeOverridesRead = (challengeId: unknown): Promise<unknown> => {
        const id = normalizeId(challengeId);
        if (id === '' || Object.hasOwn(store.compactOverrides, id)) {
            return sendInvoke('get-challenge-overrides', [challengeId]).then((result) => withPhoneOwn(id, result));
        }
        return seedChallenge(challengeId, id).then((outcome) => {
            if (outcome.overrides.status === 'rejected') return Promise.reject(outcome.overrides.error);
            if (Object.hasOwn(store.compactOverrides, id)) return withPhoneOwn(id, outcome.overrides.value);
            return outcome.overrides.value; // the seed stored nothing: the forwarded answer passes unchanged
        });
    };

    /** replace-challenge-overrides(id, overrides, suppressed): the desktop keeps its own
     * compactCards entry (the form's value is a phone-local display flag), and the phone stores
     * the form's value only once the desktop accepted the replace. A desktop edit between the
     * read and the replace can be undone by it; that race is accepted for a display flag. */
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
                // The desktop accepted, so that is the answer — storeOwn runs for its side effect
                // only, and a full map must not turn a save that succeeded into a reported failure.
                storeOwn(id, formValue);
                return true;
            });
        });
    };

    /** get-settings-schema: forwarded. The handler answers `{ schema, defaults, groups, tiers,
     * profileLimits }`, where `defaults` carries the CURRENT global defaults — those seed the
     * two globals and the phone's values replace theirs in the copy. The factory defaults in
     * `schema` are never read or changed; a non-object `defaults` seeds nothing and passes. */
    const settingsSchemaRead = (): Promise<unknown> =>
        sendInvoke('get-settings-schema', []).then((result) => {
            if (!isPlainObject(result) || !isPlainObject(result.defaults)) return result;
            let changed = false;
            for (const key of ['compactCards', 'compactCardActions'] as const) {
                if (putGlobal(key, result.defaults[key], false)) changed = true;
            }
            const defaults: Record<string, unknown> = { ...result.defaults };
            for (const key of ['compactCards', 'compactCardActions'] as const) {
                const value = store[key];
                if (value !== undefined) defaults[key] = value;
            }
            if (changed) persist();
            return { ...result, defaults };
        });

    /** Remembers a desktop settings object, seeds the four unset globals it carries, and answers
     * the overlaid copy. Per-challenge ids are not seeded here: the combined seed per id runs
     * on a challenge read instead. */
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
        if (changed) persist();
        return overlaySettings(store, payload);
    };

    /** The get/set case blocks of the two key families (`get-setting`/`set-setting` over theme
     * and language, `get-global-default`/`set-global-default` over the compact keys) share one
     * shape: a get reads the store, a set writes it and dispatches the local event. A foreign
     * key never reaches this helper — its case answers `null` = forward. */
    const keyFamilyRoute = (key: PrefKey, action: 'get' | 'set', value: unknown): Promise<unknown> => {
        if (action === 'get') return readGlobal(key);
        if (!putGlobal(key, value, true)) return Promise.resolve(false);
        persist();
        dispatchLocal();
        return Promise.resolve(true);
    };

    // Forwarded on purpose, with no renderer caller today: set-challenge-overrides, reset-setting,
    // is-setting-modified, save-settings, apply-challenge-profile. They reach the desktop's values —
    // a future caller of these writes or reads what the computer holds, not the phone's view keys.
    const route = (channel: string, args: unknown[]): Promise<unknown> | null => {
        switch (channel) {
            case 'get-setting':
            case 'set-setting': {
                const key = args[0];
                if (key !== 'theme' && key !== 'language') return null;
                return keyFamilyRoute(key, channel === 'get-setting' ? 'get' : 'set', args[1]);
            }
            case 'get-global-default':
            case 'set-global-default': {
                const key = args[0];
                if (key !== 'compactCards' && key !== 'compactCardActions') return null;
                return keyFamilyRoute(key, channel === 'get-global-default' ? 'get' : 'set', args[1]);
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
                if (pruneOverrides(store, args[0])) persist();
                return null;
            default:
                return null;
        }
    };

    return { route, ingestSettings };
};
