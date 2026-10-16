/**
 * The mirror of the configuration in settings format 1: `settings.json` is kept current, sign-in state included, so an
 * older build of the app that runs on the same data afterwards starts logged in with the current settings. One way:
 * `config.json` is the only source of truth, and nothing is read back from `settings.json` except for the import and
 * the recovery of a missing or damaged configuration (legacyImport.ts). An older build prunes and resets what it does
 * not know and writes the file back; the next start overwrites that again.
 *
 * The file the user had before the first overwrite is kept once as `settings.json.original` (never replaced
 * afterwards); once the mirror has started, the file is the app's own output and no copy is made of it. A
 * `settings.json` that does not import is never written over: it is set aside as `settings.json.unimportable-<time>`
 * first. A logout takes the sign-in out of every copy that holds one. Nothing here throws; a mirror that could not be
 * written is logged (never its text) and tried again with the next save and the next start.
 */

import * as logger from '../logger';
import * as runtime from '../runtime';
import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { V1_KEY_RENAMES } from './importV1/renames';
import { V1_MIGRATION_FLAGS } from './importV1/migrations';
import {
    clearSignOutScrubPending,
    isMirrorStarted,
    isMirrorStartedNow,
    markMirrored,
    markMirrorPending,
    markMirrorPendingQueued,
    markSignOutScrubPending,
    mirroredSignIns,
    noteCopiesScrubbed,
    mirroredSignInsNow,
    signOutScrubPendingNow,
    signOutScrubPendingStored,
} from './importMarker';
import { dropInvalidValues, mergeWithDefaults } from './loadValidation';
import { acquireSettingsLock } from './settingsLock';
import { signInChangedByOlderBuild, signInFingerprint, signInWrittenHere, tokenInSignIns } from './signInFingerprint';
import { createJsonStore, legacyStorage, storage } from './storage';
import { throughStore } from './storeTransport';
import { storedTitlePins, storedTitlePinsNow } from './titlePins';

import type { ConfigAuthV2, ConfigV2 } from '../types/config';
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

// How long the compare-and-write of `settings.json` waits for the settings lock (a desktop's other process is in the
// middle of an import or of its own mirror) before it is given up until the next save or start.
const LOCK_WAIT_MS = 200;

// How often a mirror is made again from the configuration as it is stored then, because `settings.json` changed under
// the write (another process or context mirrored at the same time), before it is given up until the next save or start.
const MAX_ATTEMPTS = 3;

/**
 * What a mirror came to: `written`; `unchanged` (`settings.json` already holds it); `skipped` (there is no usable stored
 * configuration to mirror, or its write did not land); `gave-up` (it kept changing); `busy` (another process held the
 * settings lock for the whole wait); `failed`.
 */
type MirrorOutcome = 'written' | 'unchanged' | 'skipped' | 'gave-up' | 'busy' | 'failed';

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
 * The mirror for a stored configuration text, as a load would read that configuration, the fingerprint of its sign-in,
 * and whether the configuration is signed out (no token); null when the text is absent or is not a configuration object
 * (there is nothing to mirror then).
 */
const mirrorOf = (
    configText: string | null,
    titlePins: Record<string, string>,
): { text: string; signIn: string; auth: ConfigAuthV2 } | null => {
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
    return {
        text: JSON.stringify(toFormatOne(config, titlePins), null, 2),
        signIn: signInFingerprint(config.auth),
        auth: config.auth,
    };
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

// A settings object with its sign-in state cleared, at the top level (a settings.json) and in `auth` (a config.json): the
// token, the API headers, the last user name and the chosen-photos account (a copy kept of a file is not where the login
// form is prefilled from); null when it holds none (or is not a JSON object). With `only` (the fingerprints of recorded
// sign-ins) a part is cleared only where its token is one of those: the sign-in of any other login stays.
const withoutSignIn = (kept: string, only?: readonly string[]): string | null => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(kept);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    const identity = ['lastUsername', 'chosenPhotosMemberId'] as const;
    const holdsSignIn = (values: Record<string, unknown>): boolean =>
        only === undefined
            ? (typeof values.token === 'string' && values.token !== '') ||
              (isPlainObject(values.apiHeaders) && Object.keys(values.apiHeaders).length > 0) ||
              identity.some((key) => typeof values[key] === 'string' && values[key] !== '')
            : typeof values.token === 'string' && values.token !== '' && tokenInSignIns(only, values.token);
    const cleared = (values: Record<string, unknown>) => ({
        ...values,
        token: '',
        apiHeaders: {},
        ...Object.fromEntries(identity.filter((key) => typeof values[key] === 'string').map((key) => [key, ''])),
    });
    const { auth } = parsed;
    const top = holdsSignIn(parsed);
    const nested = isPlainObject(auth) && holdsSignIn(auth);
    if (!top && !nested) return null;
    return JSON.stringify({ ...(top ? cleared(parsed) : parsed), ...(nested ? { auth: cleared(auth) } : {}) }, null, 2);
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

/**
 * A logout takes the sign-in state out of every copy kept of a settings file that holds one: the user's own file
 * (`settings.json.original`) and the files set aside (`config.json.corrupt-<time>`, `settings.json.unimportable-<time>`).
 * Only a sign-out that was saved does (a token that was stored and is cleared; see scrubCopiesAfterSignOut): a
 * configuration that merely holds no token, as the defaults of a damaged one do, is no reason to take the sign-in out of
 * the copy the user is fixing. A copy that does not parse is left as it is. Where the files are read and written in one
 * step.
 */
const scrubCopiesSync = (only?: readonly string[]): boolean => {
    const clear = (kept: string) => withoutSignIn(kept, only);
    // (`updateNow` has written when it returns, on these platforms.)
    const original = originalStore.updateNow((kept) => (kept === null ? null : clear(kept)));
    const configs = storage.rewriteSetAside(clear);
    const settingsFiles = legacyStorage.rewriteSetAside(clear);
    return original !== 'failed' && configs && settingsFiles;
};

/** `scrubCopiesSync` for the Android app window (the set-aside copies are Preferences keys). */
const scrubCopiesQueued = async (only?: readonly string[]): Promise<boolean> => {
    const clear = (kept: string) => withoutSignIn(kept, only);
    const original = await throughStore(originalStore, (kept) => (kept === null ? null : clear(kept)));
    const configs = await storage.rewriteSetAsideOnChain(clear);
    const settingsFiles = await legacyStorage.rewriteSetAsideOnChain(clear);
    return original !== 'failed' && configs && settingsFiles;
};

/**
 * What setting a `settings.json` aside came to: `kept` is where the copy went (a path), none when there was nothing to
 * keep; `queued`: it is only owed, and made before the mirror's first write (the Android app window), so that the key it
 * is written under is known only once it has landed, and `landed` (Start fresh's, which does not wait for the mirror)
 * says it then.
 */
type Aside = { ok: true; kept?: string; queued?: true; landed?: Promise<string | null> } | { ok: false; error: string };

// The text of a settings.json the app window still has to set aside before the mirror may write over it (Start fresh,
// or a settings.json that does not import), and whether as a copy of its own even when `.original` is free.
let owedAside: { raw: string; asCopy: boolean } | null = null;

/** Sets `raw` aside where the stores are read and written in one step: as `.original` if that is free (and `asCopy` is not set), else as a copy of its own. */
const setAsideSync = (raw: string, asCopy: boolean): Aside => {
    if (!asCopy && originalStore.readRaw() === null) {
        keepOriginalSync(raw);
        if (originalStore.readRaw() === raw) return { ok: true, kept: originalStore.getFilePath() };
    }
    const copy = legacyStorage.keepUnimportable(raw);
    return copy.ok ? { ok: true, kept: copy.path } : { ok: false, error: copy.error };
};

/** `setAsideSync` where the write is queued (the Android app window): the key it was written under, null when it was not. */
const setAsideQueued = async ({ raw, asCopy }: { raw: string; asCopy: boolean }): Promise<string | null> => {
    if (asCopy) return legacyStorage.keepUnimportableOnChain(raw);
    const kept = await throughStore(originalStore, (current) => (current === null ? raw : null));
    if (kept === 'saved') return ORIGINAL_SETTINGS_KEY;
    // `aborted`: `.original` is taken, a copy of its own is made; `failed`: nothing was written.
    return kept === 'aborted' ? legacyStorage.keepUnimportableOnChain(raw) : null;
};

/**
 * Makes the set-aside the app window owes; the key it was written under, or null (it failed, and stays owed). What is
 * owed is cleared only if it is still the one this settled: a newer one asked for meanwhile stays owed.
 */
const settleOwedAside = async (owed: { raw: string; asCopy: boolean }): Promise<string | null> => {
    const key = await setAsideQueued(owed);
    if (key !== null && owedAside === owed) owedAside = null;
    return key;
};

/**
 * Sets the `settings.json` that could not be imported aside, before anything is mirrored over it: as
 * `settings.json.original` when that is free (Start fresh), else, or with `asCopy`, as `settings.json.unimportable-<time>`
 * (on Android the key `gurushots-settings_unimportable-<time>`; the answer carries where the copy went). Where the write
 * is only queued (the Android app window) the mirror does it before its first write and does not write while it fails.
 */
const setAsideLegacy = ({ asCopy = false }: { asCopy?: boolean } = {}): Aside => {
    try {
        if (!legacyStorage.isLoaded()) return { ok: false, error: 'the stored settings have not been read yet' };
        const raw = legacyStorage.readRaw();
        if (!raw) return { ok: true };
        if (runtime.isCapacitor() && !runtime.isHeadlessService()) {
            const owed = { raw, asCopy };
            owedAside = owed;
            // Start fresh does not wait for the mirror to say where the file went: it is made on the write chain now,
            // ahead of the mirror's own turn there (a corrupt state's is made by the mirror, which tells persistence).
            return {
                ok: true,
                queued: true,
                ...(asCopy ? {} : { landed: legacyStorage.enqueue(() => settleOwedAside(owed), null) }),
            };
        }
        return setAsideSync(raw, asCopy);
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
    else if (outcome === 'busy')
        log.debug(
            'settings.json is being changed by another process; it is brought up to date with the next save or start',
        );
    return outcome;
};

// From the first time `settings.json` holds the mirror, it is the app's own output; the marker also records the sign-in
// it holds, so a sign-in an older build changes there is told from one the app wrote.
const startedAs = (outcome: MirrorOutcome, signIn: string): MirrorOutcome => {
    markMirrored(signIn);
    return outcome;
};

/**
 * What the persistence layer answers to a sign-in an older build changed in `settings.json`: `adopted` (it is in the
 * configuration now, and the mirror goes on from it; `landed` says when a queued write is stored), `declined` (there is
 * no configuration of its own to put it in: the mirror goes on) or `failed` (it could not be saved, and the mirror
 * writes nothing and records nothing until a later attempt adopts it).
 */
type SignInAdoption = { outcome: 'adopted'; landed?: Promise<QueuedWriteOutcome> } | { outcome: 'declined' | 'failed' };

/** What the mirror asks of persistence.ts: to adopt a sign-in an older build changed, and to hear when a set-aside it owed was made. */
type MirrorHooks = {
    adoptSignIn: (found: Partial<ConfigAuthV2>) => SignInAdoption;
    onSetAside: (key: string) => void;
};

// settings.json is read before the configuration it is made from: a mirror the other process or context writes between
// the two reads then makes this write a conflict (it rests on the older text) instead of being overwritten by a mirror of
// an older configuration. The compare and the write are made under the settings lock, so a process that does not
// follow this order (an import) is not interleaved with it either. Each time, before the write, a sign-in that
// `settings.json` holds and this build did not write (a logout or an account switch in an older build, while this one
// ran) is adopted into the configuration first, so the write does not undo it.
const mirrorSync = ({ adoptSignIn }: MirrorHooks): MirrorOutcome => {
    const outcome = ((): MirrorOutcome => {
        // Nothing is stored to mirror (a fresh install, or the configuration was set aside): no lock is taken for it
        // (the service has no lock to take).
        if (!runtime.isHeadlessService() && !storage.peekRaw()) return 'skipped';
        const lock = acquireSettingsLock(LOCK_WAIT_MS);
        if (lock === 'busy' || lock === 'unavailable') return 'busy';
        try {
            let adopted = false;
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                const current = legacyStorage.readRaw();
                const made = mirrorOf(storage.peekRaw(), storedTitlePins());
                if (made === null) return 'skipped';
                const found = adopted ? null : signInChangedByOlderBuild(current, mirroredSignIns());
                if (found !== null) {
                    const taken = adoptSignIn(found);
                    if (taken.outcome === 'failed') return 'failed';
                    if (taken.outcome === 'adopted') {
                        adopted = true;
                        continue;
                    }
                }
                if (current === made.text) return startedAs('unchanged', made.signIn);
                if (current !== null && !isMirrorStarted() && !keepOriginalSync(current)) return 'failed';
                // Recorded before the write, so that what lands is known to be this build's whether or not the record after it is made.
                if (!markMirrorPending(made.signIn, signInWrittenHere(current, mirroredSignIns()))) return 'failed';
                const written = legacyStorage.overwriteIf(current, made.text);
                if (written !== 'conflict') return written === 'written' ? startedAs('written', made.signIn) : 'failed';
            }
            return 'gave-up';
        } finally {
            lock.release();
        }
    })();
    return outcome;
};

const mirrorQueued = (
    landed: Promise<QueuedWriteOutcome | undefined> | undefined,
    { adoptSignIn, onSetAside }: MirrorHooks,
): Promise<MirrorOutcome> =>
    legacyStorage.enqueue<MirrorOutcome>(async () => {
        if ((await landed) === 'failed') return 'skipped';
        const owed = owedAside;
        if (owed !== null) {
            const key = await settleOwedAside(owed);
            if (key === null) return 'failed';
            if (owed.asCopy) onSetAside(key);
        }
        const outcome = await (async (): Promise<MirrorOutcome> => {
            let adopted = false;
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                const current = await legacyStorage.peekStored();
                // What is stored, the title pins and the marker included: the service writes them too.
                const made = mirrorOf(await storage.peekStored(), await storedTitlePinsNow());
                if (made === null) return 'skipped';
                const found = adopted ? null : signInChangedByOlderBuild(current, await mirroredSignInsNow());
                if (found !== null) {
                    const taken = adoptSignIn(found);
                    if (taken.outcome === 'failed') return 'failed';
                    if (taken.outcome === 'adopted') {
                        if ((await taken.landed) === 'failed') return 'failed';
                        adopted = true;
                        continue;
                    }
                }
                if (current === made.text) return startedAs('unchanged', made.signIn);
                if (current !== null && !(await isMirrorStartedNow()) && !(await keepOriginalQueued(current)))
                    return 'failed';
                const held = signInWrittenHere(current, await mirroredSignInsNow());
                if (!(await markMirrorPendingQueued(made.signIn, held))) return 'failed';
                if (await legacyStorage.casStored(current, made.text)) return startedAs('written', made.signIn);
            }
            return 'gave-up';
        })();
        return outcome;
    }, 'failed');

/**
 * Clears the sign-in out of the copies kept of the settings files, right after a sign-out was saved — not whenever the
 * mirror next runs, which it may not, or may find busy. Where the configuration's own write is only queued (the Android
 * app window) it waits for `landed`: a write that did not land signed nothing out, and there is nothing to clear
 * (nothing is carried to a later save). The copies are cleared one by one, and one that cannot be read or written is
 * logged and left (see storage.rewriteSetAside), so nothing here throws.
 *
 * @param landed - how the configuration's queued write ended
 */
const scrubCopiesAfterSignOut = (
    landed: Promise<QueuedWriteOutcome | undefined> | undefined,
    only?: readonly string[],
): void => {
    // Recorded (once the sign-out is saved) and cleared only when every copy was rewritten: a copy that could not be is
    // tried again at the next start or save (see finishDeferredScrub).
    if (runtime.isCapacitor() && !runtime.isHeadlessService()) {
        void legacyStorage.enqueue(async () => {
            // A sign-out that did not land signed nothing out: there is nothing to clear, and nothing is recorded (a look
            // for what is owed would clear the copies of a sign-out that never happened).
            if ((await landed) === 'failed') return;
            const record = markSignOutScrubPending();
            if (await scrubCopiesQueued(only)) {
                noteCopiesScrubbed();
                clearSignOutScrubPending(record);
            }
        }, undefined);
        return;
    }
    const record = markSignOutScrubPending();
    if (runtime.isHeadlessService()) {
        // The service has no way to list the copies in Preferences: the app window clears them (and the record) when it
        // next starts or saves.
        scrubCopiesSync(only);
    } else if (scrubCopiesSync(only)) {
        noteCopiesScrubbed();
        clearSignOutScrubPending(record);
    } else {
        scrubFailedHere = true;
    }
};

// How long a copy set aside keeps the sign-in it held after a logout that never came (the same as a remembered copy stays
// the one to fix): older copies lose the sign-in at the start, and keep their settings for recovery.
const OLD_COPY_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * At the start: the copies set aside (`config.json.corrupt-<time>`, `settings.json.unimportable-<time>`, and the Android
 * keys) that are older than OLD_COPY_AGE_MS lose the sign-in they hold, the rest of their settings kept for recovery.
 * Not the user's own file kept as `settings.json.original`. A copy that cannot be rewritten is logged and left; the next
 * start tries again. Nothing in the background service (it cannot list the copies in Preferences).
 */
const scrubOldCopies = (): void => {
    if (runtime.isHeadlessService()) return;
    if (runtime.isCapacitor()) {
        void legacyStorage.enqueue(async () => {
            await storage.rewriteSetAsideOnChain(withoutSignIn, OLD_COPY_AGE_MS);
            await legacyStorage.rewriteSetAsideOnChain(withoutSignIn, OLD_COPY_AGE_MS);
        }, undefined);
        return;
    }
    storage.rewriteSetAside(withoutSignIn, OLD_COPY_AGE_MS);
    legacyStorage.rewriteSetAside(withoutSignIn, OLD_COPY_AGE_MS);
};

// Whether a desktop process failed to rewrite a copy and so looks again at each save (else only at its start).
let scrubFailedHere = false;

// Whether a look for the clearing the app window owes is under way, and whether another was asked for meanwhile (the
// service may have recorded one after the running look read the marker).
let deferredScrubRunning = false;
let deferredScrubAgain = false;

/**
 * What is still owed for a sign-out: the copies a rewrite failed on (any platform), and the copies in Preferences the
 * background service could not reach (see scrubCopiesAfterSignOut). Asked at the start and again at each change the
 * Android window saves, since the service may sign out while the window is open (a desktop looks again at each save only
 * after a rewrite failed). Nothing in the service; one look at a time, and a look asked for while one runs is made when it
 * ends.
 */
const finishDeferredScrub = (atStart = false): void => {
    if (runtime.isHeadlessService()) return;
    if (!runtime.isCapacitor()) {
        // A desktop: the copies are files, and the record is in the marker file. Looked at when the process starts, and
        // at each save only after a rewrite failed here.
        if (!atStart && !scrubFailedHere) return;
        scrubFailedHere = false;
        const pending = signOutScrubPendingStored();
        if (pending === null) return;
        if (scrubCopiesSync()) {
            noteCopiesScrubbed();
            clearSignOutScrubPending(pending);
        } else scrubFailedHere = true;
        return;
    }
    if (deferredScrubRunning) {
        deferredScrubAgain = true;
        return;
    }
    deferredScrubRunning = true;
    void legacyStorage
        .enqueue(async () => {
            const pending = await signOutScrubPendingNow();
            if (pending === null) return;
            if (await scrubCopiesQueued()) {
                noteCopiesScrubbed();
                clearSignOutScrubPending(pending);
            }
        }, undefined)
        .finally(() => {
            deferredScrubRunning = false;
            if (deferredScrubAgain) {
                deferredScrubAgain = false;
                finishDeferredScrub();
            }
        });
};

/**
 * Brings `settings.json` up to date with the stored configuration. Where the configuration's own write is only queued
 * (the Android app window), the mirror waits on its `landed` outcome and derives the text from what Preferences holds
 * then; nothing is mirrored from a write that did not land. Never throws; the outcome is logged, and a mirror that did
 * not go through is made again by the next save or start.
 *
 * @param landed - how the configuration's queued write ended
 * @param hooks - what the mirror asks of persistence.ts
 */
const mirrorSettings = (landed: Promise<QueuedWriteOutcome | undefined> | undefined, hooks: MirrorHooks): void => {
    try {
        if (runtime.isCapacitor() && !runtime.isHeadlessService()) {
            void mirrorQueued(landed, hooks).then(noteOutcome);
        } else {
            noteOutcome(mirrorSync(hooks));
        }
    } catch (error) {
        logger
            .withCategory('settings')
            .warning(`settings.json could not be brought up to date: ${errorMessage(error) ?? 'unknown error'}`);
    }
};

export type { SignInAdoption };
export {
    ORIGINAL_SETTINGS_KEY,
    mirrorSettings,
    mirrorTextOf,
    finishDeferredScrub,
    originalStore,
    scrubCopiesAfterSignOut,
    scrubOldCopies,
    setAsideLegacy,
    toFormatOne,
};
