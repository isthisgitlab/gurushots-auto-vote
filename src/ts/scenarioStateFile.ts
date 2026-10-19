/**
 * The scenario state file: what may be stored in it, how it is read and written, and the locks and reset counts that
 * keep one process's change from undoing another's (see scenarioStateStore.ts for the shape and the ledger over it).
 */

import type { RawJsonStore, ScenarioEpoch, ScenarioState, SpendAction } from './types/stores';
import * as logger from './logger';
import * as runtime from './runtime';
import { isPlainObject } from './plainObject';
import { acquireWithin } from './lockWait';
import { throughStore } from './settings/storeTransport';

/** A cross-process lock, as joinStateStore's acquireUnlockLock gives one. */
type StateLock = { ok: boolean; release: () => void; unavailable?: true; held?: () => boolean };

// `unloaded`: the app's cache has not been filled yet (a start-up read of the file failed), which is not the same as a
// file that cannot be read: nothing is known of what is stored, and nothing is reset until it is.
type ParsedStateFile = { ok: boolean; map: Record<string, unknown>; unloaded?: true };

/**
 * How a reset ended: done, or why not: a lock is held, the app cannot make its locks, the file is unreadable or not
 * loaded yet, it was asked for only if it is unreadable and it reads again, or the write was not saved (nothing changed).
 */
type ResetResult = 'removed' | 'busy' | 'unavailable' | 'unreadable' | 'unloaded' | 'readable' | 'not-saved';

/**
 * What a change of the file came to: `refused` is a write of a state read before a reset, `busy` a lock another
 * holds, `unavailable` a lock that cannot be made at all, `unreadable` a file that cannot be read.
 */
type Mutation = 'done' | 'busy' | 'unavailable' | 'unreadable' | 'refused';

/** The resets asked for, by challenge id (and of every challenge, under ALL_KEY), as the count each is to reach. */
type ResetRequests = Record<string, number>;

const NO_LOCK: StateLock = { ok: true, release: () => {} };

// Challenges run for days, not months; anything older is a finished challenge.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// The state file is one file for every challenge, so a change of it is read-modify-write of the whole: two processes
// running different challenges would drop each other's change (a fired rule, a spend counter, an unclear marker,
// and with it the protection against repeating a landed spend). It is changed only under this lock, held briefly.
const FILE_LOCK_ID = 'scenariostate';
const FILE_LOCK_WAIT_MS = 500;
// The file's count of resets of every challenge (a challenge id is never a key like it).
const ALL_KEY = '@all';

const SPEND_ACTIONS: ReadonlySet<unknown> = new Set<SpendAction>(['swap', 'unlockBoost', 'fillExposure']);

const isSpendAction = (value: unknown): value is SpendAction => SPEND_ACTIONS.has(value);

// A count of resets, or of anything else that only grows: a whole number a double can still count past. A value
// at the edge of that would freeze the counter (adding one changes nothing), so it is not one.
const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const countOf = (value: unknown): number => (isCount(value) ? value : 0);

const isFiredRecord = (value: unknown): boolean =>
    isPlainObject(value) &&
    (value.unclearHalt === undefined || isSpendAction(value.unclearHalt)) &&
    (value.haltOrigin === undefined || value.haltOrigin === 'pending');

const isStringMap = (value: unknown): boolean =>
    isPlainObject(value) && Object.values(value).every((v) => typeof v === 'string');

// One vote sample, [unixSec, votes] (scenarios/speed.ts), and the samples of every photo.
const isSample = (value: unknown): boolean =>
    Array.isArray(value) && value.length === 2 && value.every((n) => Number.isFinite(n));

const isHistory = (value: unknown): boolean =>
    isPlainObject(value) && Object.values(value).every((samples) => Array.isArray(samples) && samples.every(isSample));

// One notice for the host notifiers (scenarioRunner/rule.ts withNotice).
const isNotice = (value: unknown): boolean =>
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    Number.isFinite(value.at) &&
    typeof value.message === 'string';

const isInFlight = (value: unknown): boolean =>
    isPlainObject(value) &&
    typeof value.ruleId === 'string' &&
    Number.isInteger(value.actionIndex) &&
    (value.unclear === undefined || (Array.isArray(value.unclear) && value.unclear.every(isSpendAction))) &&
    (value.pending === undefined || isSpendAction(value.pending)) &&
    (value.lost === undefined || (Array.isArray(value.lost) && value.lost.every(isSpendAction))) &&
    (value.unclearAt === undefined || Number.isFinite(value.unclearAt));

/**
 * @param r - an untrusted parsed-JSON value
 */
const isRecord = (r: unknown): r is ScenarioState =>
    isPlainObject(r) &&
    typeof r.scenario === 'string' &&
    typeof r.phase === 'string' &&
    Number.isFinite(r.phaseEnteredAt) &&
    isStringMap(r.memory) &&
    isPlainObject(r.fired) &&
    Object.values(r.fired).every(isFiredRecord) &&
    isPlainObject(r.spent) &&
    Object.values(r.spent).every((count) => Number.isFinite(count) && Number(count) >= 0) &&
    (r.history === undefined || isHistory(r.history)) &&
    (r.outbox === undefined || (Array.isArray(r.outbox) && r.outbox.every(isNotice))) &&
    (r.inFlight === null || isInFlight(r.inFlight)) &&
    (r.gen === undefined || isCount(r.gen));

// What a reset of one challenge leaves in its place: the record is gone, its count of resets is not.
const isTombstone = (r: unknown): boolean => isPlainObject(r) && r.tombstone === true && isCount(r.gen);

// `updatedAt` is when the reset was made: what a tombstone is worth ages from then, wherever it is written.
const tombstone = (gen: number, updatedAt = Date.now()) => ({ tombstone: true, gen, updatedAt });

/**
 * The resets a challenge's state is read under: of every challenge, and of this one. A tombstone keeps the count of
 * a challenge whose record was reset away; a record that cannot be read has none.
 */
const epochOf = (map: Record<string, unknown>, key: string): ScenarioEpoch => {
    const record = map[key];
    return { all: countOf(map[ALL_KEY]), gen: isPlainObject(record) ? countOf(record.gen) : 0 };
};

// A count that is higher than the last one, and than any a clock-less earlier reset could have left.
const nextCount = (previous: number): number => Math.max(previous + 1, Date.now());

/**
 * The state file's text as a map. No file is no state yet; a file with nothing in it was cut short, and is not read
 * as "no state".
 */
const parseStateFile = (raw: string | null): ParsedStateFile => {
    try {
        const value: unknown = raw === null ? {} : JSON.parse(raw);
        return isPlainObject(value) ? { ok: true, map: value } : { ok: false, map: {} };
    } catch {
        return { ok: false, map: {} };
    }
};

const parseRequests = (raw: string | null): ResetRequests => {
    try {
        const value: unknown = raw === null ? {} : JSON.parse(raw);
        return isPlainObject(value)
            ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => isCount(entry[1])))
            : {};
    } catch {
        return {};
    }
};

/**
 * The requests still worth keeping: those not older than a tombstone or a record is kept for (a count is when the reset
 * was asked for, so a request ages out together with the tombstone it made, and cannot make a pruned one again) and,
 * however old, those not applied yet to a record that still exists. A record that holds a stop is never pruned, so a
 * reset asked for it must not be forgotten while it stands: the stop would come back to life.
 */
const liveRequests = (requests: ResetRequests, map: Record<string, unknown>): ResetRequests => {
    const cutoff = Date.now() - MAX_AGE_MS;
    const unapplied = (key: string, count: number): boolean =>
        key === ALL_KEY
            ? count > countOf(map[ALL_KEY]) && Object.keys(map).some((other) => other !== ALL_KEY)
            : isPlainObject(map[key]) && count > epochOf(map, key).gen;
    return Object.fromEntries(
        Object.entries(requests).filter(([key, count]) => count > cutoff || unapplied(key, count)),
    );
};

/**
 * The map as the resets asked for since it was written leave it: every challenge's records gone, and a tombstone for
 * each challenge asked to be reset, for each request that is ahead of what the map already counts. Applying one
 * twice changes nothing, so it can be applied by whichever runtime reads or writes next.
 */
const withRequests = (map: Record<string, unknown>, asked: ResetRequests): Record<string, unknown> => {
    const requests = liveRequests(asked, map);
    const all = requests[ALL_KEY] ?? 0;
    let next = all > countOf(map[ALL_KEY]) ? { [ALL_KEY]: all } : map;
    for (const [key, count] of Object.entries(requests)) {
        if (key !== ALL_KEY && count > epochOf(next, key).gen) next = { ...next, [key]: tombstone(count, count) };
    }
    return next;
};

/**
 * Whether a record still holds a spend that is not known to have been made or not (a marker) or a rule that was
 * stopped for one: what protects against spending it again. It is kept until it is reset, however long nothing
 * touched it: such a record is small, and an unattended stop is for the user to look at, not for a clock to forget.
 */
const holdsStop = (record: ScenarioState): boolean =>
    Boolean(record.inFlight?.unclear?.length || record.inFlight?.pending) ||
    Object.values(record.fired).some((fired) => fired.unclearHalt !== undefined);

/**
 * The map without the records of challenges that finished long ago (the count of resets of every challenge stays).
 * What cannot be read as a record or a tombstone is kept: it is for the user to reset, not for a write of another
 * challenge to delete.
 */
const pruned = (map: Record<string, unknown>): Record<string, unknown> => {
    const cutoff = Date.now() - MAX_AGE_MS;
    const keep = (key: string, entry: unknown): boolean =>
        key === ALL_KEY ||
        !(isRecord(entry) || isTombstone(entry)) ||
        (isRecord(entry) && holdsStop(entry)) ||
        (isPlainObject(entry) && typeof entry.updatedAt === 'number' && entry.updatedAt > cutoff);
    return Object.fromEntries(Object.entries(map).filter(([key, entry]) => keep(key, entry)));
};

/**
 * The state file as it reads: its text parsed, with the resets asked for since it was written applied. An unreadable
 * file is logged, and stays unreadable.
 */
const viewOf = (raw: string | null, asked: string | null): ParsedStateFile => {
    const parsed = parseStateFile(raw);
    if (parsed.ok) return { ok: true, map: withRequests(parsed.map, parseRequests(asked)) };
    logger.withCategory('scenario').error('scenario state file is unreadable', null);
    return parsed;
};

// What a write that was or was not made comes to for a reset: asked for or made, left alone for a file that reads (when
// that was the condition), or not saved.
const RESET_OF = { saved: 'removed', aborted: 'readable', failed: 'not-saved' } as const;

// How many times `key` (a challenge id, or ALL_KEY) was reset, as the map has it.
const resetsOf = (map: Record<string, unknown>, key: string): number =>
    key === ALL_KEY ? countOf(map[ALL_KEY]) : epochOf(map, key).gen;

/**
 * Takes the file's cross-process lock, waited for a moment: the lock, or why there is none.
 */
const takeLock = (acquireLock: ((id: string) => StateLock) | undefined): StateLock | 'busy' | 'unavailable' => {
    const lock = acquireLock ? acquireWithin(() => acquireLock(FILE_LOCK_ID), FILE_LOCK_WAIT_MS) : NO_LOCK;
    if (lock === 'unavailable') {
        logger
            .withCategory('scenario')
            .error('the app cannot create its lock files in its data folder — scenario state not written', null);
    }
    if (lock === 'busy') {
        logger.withCategory('scenario').warning('scenario state is locked by another process — nothing written', null);
    }
    return lock;
};

/**
 * Runs `change` under the file's cross-process lock, waited for a moment: `done`, or why nothing ran.
 */
const underLock = (
    acquireLock: ((id: string) => StateLock) | undefined,
    change: () => void,
): 'done' | 'busy' | 'unavailable' => {
    const lock = takeLock(acquireLock);
    if (typeof lock === 'string') return lock;
    try {
        change();
        return 'done';
    } finally {
        lock.release();
    }
};

/** underLock for a change that waits for something (a write that is only saved later). */
const underLockAsync = async (
    acquireLock: ((id: string) => StateLock) | undefined,
    change: () => Promise<void>,
): Promise<'done' | 'busy' | 'unavailable'> => {
    const lock = takeLock(acquireLock);
    if (typeof lock === 'string') return lock;
    try {
        await change();
        return 'done';
    } finally {
        lock.release();
    }
};

/**
 * The resets over the state file (see createStateFile): asked for where resets are asked for, else made on the file under
 * its lock.
 */
const createResets = ({
    store,
    acquireLock,
    read,
    asRequests,
    write,
}: {
    store: RawJsonStore;
    acquireLock: ((id: string) => StateLock) | undefined;
    read: () => ParsedStateFile;
    asRequests: () => RawJsonStore | undefined;
    write: (map: Record<string, unknown>) => void;
}) => {
    // The file as it is stored, without the resets asked for since: what a request is judged against.
    const stored = () => parseStateFile(store.readRaw()).map;

    /**
     * Asks for the reset of `key` (a challenge id, or ALL_KEY) rather than making it: writes only the small store of
     * requests, with a count ahead of the one asked for before and of the file's. The request shows only once it is
     * saved, so one that was not has taken effect nowhere. With `onlyIfUnreadable` it is not asked for while the file
     * reads: that is decided on the file as it is when the request is written.
     */
    const askFor = async (asking: RawJsonStore, key: string, onlyIfUnreadable = false): Promise<ResetResult> => {
        // Worked out once: the update may be made again on a newer value, and must ask for the same count.
        let count: number | undefined;
        return RESET_OF[
            await throughStore(asking, (current) => {
                if (onlyIfUnreadable && parseStateFile(store.readRaw()).ok) return null;
                const asked = parseRequests(current);
                count ??= nextCount(Math.max(asked[key] ?? 0, resetsOf(read().map, key)));
                return JSON.stringify({ ...liveRequests(asked, stored()), [key]: Math.max(asked[key] ?? 0, count) });
            })
        ];
    };

    /**
     * Resets one challenge: asked for where resets are asked for, else made on the file under its lock (a tombstone
     * that keeps the count). An unreadable file is left as it is: clearing it takes a reset of every challenge.
     */
    const resetOne = async (key: string): Promise<ResetResult> => {
        const view = read();
        if (view.unloaded) return 'unloaded';
        const asking = asRequests();
        if (view.ok && asking) return askFor(asking, key);
        let result: ResetResult = 'unreadable';
        const ran = underLock(acquireLock, () => {
            const { ok, map } = read();
            if (!ok) return;
            write({ ...map, [key]: tombstone(nextCount(epochOf(map, key).gen)) });
            result = 'removed';
        });
        return ran === 'done' ? result : ran;
    };

    /**
     * Resets every challenge, an unreadable file included (there is nothing in it to lose). With `onlyIfUnreadable`
     * the reset is made only while the file cannot be read: one that reads again was a failed read, and its progress
     * is not what the caller meant to wipe. That is decided on the file as it is where the write is made (under the
     * lock, or when the write's turn comes), not on what was read before.
     */
    const resetAll = async (onlyIfUnreadable = false): Promise<ResetResult> => {
        const view = read();
        if (view.unloaded) return 'unloaded';
        const asking = asRequests();
        // A file that reads is left alone before any lock is wanted; one that reads by the time it is held, too.
        if (onlyIfUnreadable && view.ok && !asking) return 'readable';
        if (view.ok && asking) return askFor(asking, ALL_KEY, onlyIfUnreadable);
        let result: ResetResult = 'not-saved';
        const ran = await underLockAsync(acquireLock, async () => {
            result =
                RESET_OF[
                    await throughStore(store, (current) => {
                        const parsed = parseStateFile(current);
                        if (onlyIfUnreadable && parsed.ok) return null;
                        return JSON.stringify({ [ALL_KEY]: nextCount(parsed.ok ? countOf(parsed.map[ALL_KEY]) : 0) });
                    })
                ];
        });
        return ran === 'done' ? result : ran;
    };

    return { resetOne, resetAll };
};

/**
 * The state file over a raw-JSON store: its parsed text (re-parsed only when the stored text changed: the engine and
 * the settings overlay read state many times per pass), its whole-file write (older records pruned) and the lock its
 * changes are made under.
 *
 * Where a reset must not rewrite the file from a cache a service may have gone stale on (the Android app, whose
 * background service writes the same key), it is asked for instead, in a small store of its own (`requests`), and
 * applied by whichever runtime reads or writes the file next.
 *
 * @param acquireLock - the cross-process lock of the file's changes; none where one process owns the file (mock
 *   mode, Android) and in tests
 * @param requests - the store of asked-for resets, used on Android only
 * @param isLoaded - whether the stores hold what is saved (the Android app's caches do not until they are read); until
 *   they do, the file reads as `unloaded` and nothing is changed
 */
const createStateFile = (
    store: RawJsonStore,
    acquireLock?: (id: string) => StateLock,
    requests?: RawJsonStore,
    isLoaded: () => boolean = () => true,
) => {
    let lastRaw: string | null | undefined;
    let lastRequests: string | null | undefined;
    let lastParsed: ParsedStateFile | undefined;

    const asRequests = (): RawJsonStore | undefined =>
        runtime.isCapacitor() || runtime.isHeadlessService() ? requests : undefined;

    const read = (): ParsedStateFile => {
        const raw = store.readRaw();
        const asked = asRequests()?.readRaw() ?? null;
        // After the reads: a read that failed says so only once it was made.
        if (!isLoaded()) return { ok: false, map: {}, unloaded: true };
        // lastParsed is set together with lastRaw, and readRaw never returns undefined.
        if (raw === lastRaw && asked === lastRequests) return lastParsed as ParsedStateFile;
        lastRaw = raw;
        lastRequests = asked;
        lastParsed = viewOf(raw, asked);
        return lastParsed;
    };

    const write = (map: Record<string, unknown>) => store.writeRaw(JSON.stringify(pruned(map)));

    /**
     * Rewrites the file as `change` makes it from the file as it is now (read again under the lock); `change`
     * answers null to refuse. An unreadable file is never replaced by one challenge's change: that would wipe every
     * challenge's progress.
     */
    const mutate = (change: (map: Record<string, unknown>) => Record<string, unknown> | null): Mutation => {
        let result: Mutation = 'unreadable';
        const ran = underLock(acquireLock, () => {
            const { ok, map } = read();
            if (!ok) return;
            const next = change(map);
            if (next) write(next);
            result = next ? 'done' : 'refused';
        });
        return ran === 'done' ? result : ran;
    };

    return { read, mutate, ...createResets({ store, acquireLock, read, asRequests, write }) };
};

export { ALL_KEY, createStateFile, epochOf, isRecord, isTombstone };
export type { Mutation, ResetResult, StateLock };
