/**
 * The mirror of the configuration in settings format 1: `settings.json` is kept current, sign-in state included, so an
 * older build of the app that runs on the same data afterwards starts logged in with the current settings. One way:
 * `config.json` is the only source of truth, and nothing is read back from `settings.json` except for the import and
 * the recovery of a missing or damaged configuration (legacyImport.ts). An older build prunes and resets what it does
 * not know and writes the file back; the next start overwrites that again.
 *
 * The file the user had before the first overwrite is kept once as `settings.json.original` (never replaced
 * afterwards); once the mirror has started, the file is the app's own output and no copy is made of it. Nothing here throws; a mirror that could not be written is logged (never its text) and tried again
 * with the next save and the next start.
 */

import * as logger from '../logger';
import * as runtime from '../runtime';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { V1_KEY_RENAMES } from './importV1/renames';
import { V1_MIGRATION_FLAGS } from './importV1/migrations';
import { isMirrorStarted, markMirrorStarted } from './importMarker';
import { dropInvalidValues, mergeWithDefaults } from './loadValidation';
import { createJsonStore, legacyStorage, storage } from './storage';
import { throughStore } from './storeTransport';
import { storedTitlePins } from './titlePins';

import type { ConfigV2 } from '../types/config';
import type { QueuedWriteOutcome } from './storage';

/** The Preferences key of the copy kept of the file the user had (what `settings.json.original` is on a desktop). */
const ORIGINAL_SETTINGS_KEY = 'gurushots-settings_original';

// Atomic and shared: written once, by whichever context (the app window or the background service) is first; the
// native store takes it by compare-and-set only.
const originalStore = createJsonStore({
    fileName: 'settings.json.original',
    prefKey: ORIGINAL_SETTINGS_KEY,
    atomic: true,
    shared: true,
});

// How often a mirror is made again from the configuration as it is stored then, because `settings.json` changed under
// the write (another process or context mirrored at the same time), before it is given up until the next save or start.
const MAX_ATTEMPTS = 3;

/**
 * What a mirror came to: `written`; `unchanged` (`settings.json` already holds it); `skipped` (there is no usable stored
 * configuration to mirror, or its write did not land); `gave-up` (it kept changing); `failed`.
 */
type MirrorOutcome = 'written' | 'unchanged' | 'skipped' | 'gave-up' | 'failed';

// The format-1 name of each renamed key.
const FORMAT_ONE_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(V1_KEY_RENAMES).map(([formatOne, current]) => [current, formatOne]),
);

const isRenamed = (key: string): boolean => Object.hasOwn(FORMAT_ONE_NAMES, key);

/**
 * A copy of a settings map under the format-1 key names. Where a key is there under both names, the current one's value
 * is the one kept, so the same configuration always mirrors to the same text.
 */
const formatOneKeys = (values: Record<string, unknown>): Record<string, unknown> => {
    const entries = Object.entries(values);
    const renamed = entries
        .filter(([key]) => isRenamed(key))
        .map(([key, value]): [string, unknown] => [FORMAT_ONE_NAMES[key], value]);
    return Object.fromEntries([...entries.filter(([key]) => !isRenamed(key)), ...renamed]);
};

const formatOneValue = (value: unknown): unknown => (isPlainObject(value) ? formatOneKeys(value) : value);

const mapEntries = (values: Record<string, unknown>, convert: (item: unknown) => unknown): Record<string, unknown> =>
    Object.fromEntries(Object.entries(values).map(([key, item]) => [key, convert(item)]));

// A scenario document with the setting keys of every phase's `settings` under their format-1 names.
const formatOneScenario = (doc: unknown): unknown => {
    if (!isPlainObject(doc) || !isPlainObject(doc.phases)) return doc;
    return {
        ...doc,
        phases: mapEntries(doc.phases, (phase) =>
            isPlainObject(phase) && isPlainObject(phase.settings)
                ? { ...phase, settings: formatOneKeys(phase.settings) }
                : phase,
        ),
    };
};

/**
 * The configuration (and the title pins kept beside it) as the settings blob an older build reads: the keys under their
 * format-1 names, `auth` back among the top-level keys, `challenges` split into `perChallenge`,
 * `titleProfileSuppressions` and `entryPins`, `defaults` as `globalDefaults`, every one-time migration marked done (the
 * values are migrated already, so an older build never migrates them again), and no `version` or `imported`.
 */
const toFormatOne = (config: ConfigV2, titlePins: Record<string, string>): Record<string, unknown> => {
    const records = Object.entries(config.challenges);
    return {
        ...formatOneKeys(config.app),
        ...config.auth,
        ...Object.fromEntries(V1_MIGRATION_FLAGS.map((flag) => [flag, true])),
        challengeSettings: {
            globalDefaults: formatOneKeys(config.defaults),
            perChallenge: Object.fromEntries(
                records.flatMap(([id, record]) =>
                    record.values === undefined ? [] : [[id, formatOneKeys(record.values)]],
                ),
            ),
            titleRules: config.rules.map(formatOneValue),
            titleProfileSuppressions: Object.fromEntries(
                records.filter(([, record]) => record.suppressRuleProfile).map(([id]) => [id, true]),
            ),
            entryPins: Object.fromEntries(
                records.flatMap(([id, record]) => (record.pins === undefined ? [] : [[id, record.pins]])),
            ),
            profiles: mapEntries(config.profiles, formatOneValue),
            seededProfiles: config.seededProfiles,
            scenarios: mapEntries(config.scenarios, formatOneScenario),
            titlePins,
        },
    };
};

/**
 * The mirror for a stored configuration text, as a load would read that configuration, and whether the configuration
 * is signed out (no token); null when the text is absent or is not a configuration object (there is nothing to mirror
 * then).
 */
const mirrorOf = (
    configText: string | null,
    titlePins: Record<string, string>,
): { text: string; signedOut: boolean } | null => {
    if (!configText) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(configText);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    const config = mergeWithDefaults(parsed);
    dropInvalidValues(config);
    return { text: JSON.stringify(toFormatOne(config, titlePins), null, 2), signedOut: config.auth.token === '' };
};

/**
 * The text of `settings.json` for a stored configuration text; null when there is nothing to mirror.
 *
 * @param titlePins - the pins kept beside the configuration (the title-pin cache as it is now, as stored)
 */
const mirrorTextOf = (
    configText: string | null,
    titlePins: Record<string, string> = storedTitlePins(),
): string | null => mirrorOf(configText, titlePins)?.text ?? null;

// What a copy kept of the user's file holds once its sign-in state is cleared; null when it holds none (or is not JSON).
const withoutSignIn = (kept: string): string | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(kept);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    const holdsToken = typeof parsed.token === 'string' && parsed.token !== '';
    const holdsHeaders = isPlainObject(parsed.apiHeaders) && Object.keys(parsed.apiHeaders).length > 0;
    if (!holdsToken && !holdsHeaders) return null;
    return JSON.stringify({ ...parsed, token: '', apiHeaders: {} }, null, 2);
};

/**
 * Keeps `current` (the text `settings.json` holds) as `settings.json.original` unless a copy is there already, where the
 * store is read and written in one step (a desktop, the background service): the copy is made when this returns.
 *
 * @returns whether a copy is kept now
 */
const keepOriginalSync = (current: string): boolean => {
    // `updateThrough` never rejects (it answers `failed`), and on these platforms it has written when it returns.
    void throughStore(originalStore, (kept) => (kept === null ? current : null));
    return originalStore.readRaw() !== null;
};

/** `keepOriginalSync` where the write is queued (the Android app window): says so once the copy is stored. */
const keepOriginalQueued = async (current: string): Promise<boolean> =>
    (await throughStore(originalStore, (kept) => (kept === null ? current : null))) !== 'failed';

/** Clears the token and the API headers from the copy of the user's file, where it is read and written in one step. */
const scrubOriginalSync = (): void => {
    void throughStore(originalStore, (kept) => (kept === null ? null : withoutSignIn(kept)));
};

const scrubOriginalQueued = async (): Promise<void> => {
    await throughStore(originalStore, (kept) => (kept === null ? null : withoutSignIn(kept)));
};

type Aside = { ok: true } | { ok: false; error: string };

// The text of a settings.json the app window still has to set aside before the mirror may write over it (Start fresh).
let owedAside: string | null = null;

/** Sets `raw` aside where the stores are read and written in one step: as `.original` if that is free, else as a copy of its own. */
const setAsideSync = (raw: string): Aside => {
    if (originalStore.readRaw() === null) {
        keepOriginalSync(raw);
        if (originalStore.readRaw() === raw) return { ok: true };
    }
    const copy = legacyStorage.keepUnimportable(raw);
    return copy.ok ? { ok: true } : { ok: false, error: copy.error };
};

/** `setAsideSync` where the write is queued (the Android app window). */
const setAsideQueued = async (raw: string): Promise<boolean> => {
    const kept = await throughStore(originalStore, (current) => (current === null ? raw : null));
    if (kept === 'saved') return true;
    // `aborted`: `.original` is taken, a copy of its own is made; `failed`: nothing was written.
    return kept === 'aborted' && (await legacyStorage.keepUnimportableOnChain(raw));
};

/**
 * Sets the `settings.json` that could not be imported aside, before anything is mirrored over it: as
 * `settings.json.original` when that is free, else as `settings.json.unimportable-<time>` (on Android the key
 * `gurushots-settings_unimportable-<time>`). Where the write is only queued (the Android app window) the mirror does it
 * before its first write and does not write while it fails.
 */
const setAsideLegacy = (): Aside => {
    try {
        if (!legacyStorage.isLoaded()) return { ok: false, error: 'the stored settings have not been read yet' };
        const raw = legacyStorage.readRaw();
        if (!raw) return { ok: true };
        if (runtime.isCapacitor() && !runtime.isHeadlessService()) {
            owedAside = raw;
            return { ok: true };
        }
        return setAsideSync(raw);
    } catch (error) {
        return { ok: false, error: errorMessage(error) ?? 'unknown error' };
    }
};

const noteOutcome = (outcome: MirrorOutcome): MirrorOutcome => {
    const log = logger.withCategory('settings');
    if (outcome === 'written') log.debug('settings.json was brought up to date with the configuration');
    else if (outcome === 'failed')
        log.warning('settings.json could not be brought up to date; it is tried again later');
    else if (outcome === 'gave-up')
        log.info('settings.json kept changing under the update; it is tried again with the next save or start');
    return outcome;
};

// From the first time `settings.json` holds the mirror, it is the app's own output.
const startedAs = (outcome: MirrorOutcome): MirrorOutcome => {
    markMirrorStarted();
    return outcome;
};

// settings.json is read before the configuration it is made from: a mirror the other process or context writes between
// the two reads then makes this write a conflict (it rests on the older text) instead of being overwritten by a mirror of
// an older configuration.
const mirrorSync = (): MirrorOutcome => {
    let signedOut = false;
    const outcome = ((): MirrorOutcome => {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const current = legacyStorage.readRaw();
            const made = mirrorOf(storage.peekRaw(), storedTitlePins());
            if (made === null) return 'skipped';
            signedOut = made.signedOut;
            if (current === made.text) return startedAs('unchanged');
            if (current !== null && !isMirrorStarted() && !keepOriginalSync(current)) return 'failed';
            const written = legacyStorage.overwriteIf(current, made.text);
            if (written !== 'conflict') return written === 'written' ? startedAs('written') : 'failed';
        }
        return 'gave-up';
    })();
    // A logout takes the sign-in state out of the copy kept of the user's file too.
    if (signedOut) scrubOriginalSync();
    return outcome;
};

const mirrorQueued = (landed?: Promise<QueuedWriteOutcome | undefined>): Promise<MirrorOutcome> =>
    legacyStorage.enqueue<MirrorOutcome>(async () => {
        if ((await landed) === 'failed') return 'skipped';
        if (owedAside !== null) {
            if (!(await setAsideQueued(owedAside))) return 'failed';
            owedAside = null;
        }
        let signedOut = false;
        const outcome = await (async (): Promise<MirrorOutcome> => {
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                const current = await legacyStorage.peekStored();
                const made = mirrorOf(await storage.peekStored(), storedTitlePins());
                if (made === null) return 'skipped';
                signedOut = made.signedOut;
                if (current === made.text) return startedAs('unchanged');
                if (current !== null && !isMirrorStarted() && !(await keepOriginalQueued(current))) return 'failed';
                if (await legacyStorage.casStored(current, made.text)) return startedAs('written');
            }
            return 'gave-up';
        })();
        if (signedOut) await scrubOriginalQueued();
        return outcome;
    }, 'failed');

/**
 * Brings `settings.json` up to date with the stored configuration. Where the configuration's own write is only queued
 * (the Android app window), the mirror waits on its `landed` outcome and derives the text from what Preferences holds
 * then; nothing is mirrored from a write that did not land. Never throws; the outcome is logged, and a mirror that did
 * not go through is made again by the next save or start.
 *
 * @param landed - how the configuration's queued write ended
 */
const mirrorSettings = (landed?: Promise<QueuedWriteOutcome | undefined>): void => {
    try {
        if (runtime.isCapacitor() && !runtime.isHeadlessService()) {
            void mirrorQueued(landed).then(noteOutcome);
        } else {
            noteOutcome(mirrorSync());
        }
    } catch (error) {
        logger
            .withCategory('settings')
            .warning(`settings.json could not be brought up to date: ${errorMessage(error) ?? 'unknown error'}`);
    }
};

export { ORIGINAL_SETTINGS_KEY, mirrorSettings, mirrorTextOf, originalStore, setAsideLegacy, toFormatOne };
