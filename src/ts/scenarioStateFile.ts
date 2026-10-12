/**
 * The scenario state file: what may be stored in it, how it is read and written, and the locks and reset counts that
 * keep one process's change from undoing another's (see scenarioStateStore.ts for the shape and the ledger over it).
 */

import type { RawJsonStore, ScenarioEpoch, ScenarioState, SpendAction } from './types/stores';
import * as logger from './logger';
import * as runtime from './runtime';
import { isPlainObject } from './plainObject';
import { acquireWithin } from './lockWait';

/** A cross-process lock, as joinStateStore's acquireUnlockLock gives one. */
type StateLock = { ok: boolean; release: () => void; unavailable?: true };

type ParsedStateFile = { ok: boolean; map: Record<string, unknown> };

/** How a reset ended: done, or why not (a lock is held, the app cannot make its locks, the file is unreadable). */
type ResetResult = 'removed' | 'busy' | 'unavailable' | 'unreadable';

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

const isInFlight = (value: unknown): boolean =>
    isPlainObject(value) &&
    typeof value.ruleId === 'string' &&
    Number.isInteger(value.actionIndex) &&
    (value.unclear === undefined || (Array.isArray(value.unclear) && value.unclear.every(isSpendAction))) &&
    (value.pending === undefined || isSpendAction(value.pending)) &&
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
    (r.history === undefined || isPlainObject(r.history)) &&
    (r.outbox === undefined || Array.isArray(r.outbox)) &&
    (r.inFlight === null || isInFlight(r.inFlight)) &&
    (r.gen === undefined || isCount(r.gen));

// What a reset of one challenge leaves in its place: the record is gone, its count of resets is not.
const isTombstone = (r: unknown): boolean => isPlainObject(r) && r.tombstone === true && isCount(r.gen);

const tombstone = (gen: number) => ({ tombstone: true, gen, updatedAt: Date.now() });

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
 * The map as the resets asked for since it was written leave it: every challenge's records gone, and a tombstone for
 * each challenge asked to be reset, for each request that is ahead of what the map already counts. Applying one
 * twice changes nothing, so it can be applied by whichever runtime reads or writes next.
 */
const withRequests = (map: Record<string, unknown>, requests: ResetRequests): Record<string, unknown> => {
    const all = requests[ALL_KEY] ?? 0;
    let next = all > countOf(map[ALL_KEY]) ? { [ALL_KEY]: all } : map;
    for (const [key, count] of Object.entries(requests)) {
        if (key !== ALL_KEY && count > epochOf(next, key).gen) next = { ...next, [key]: tombstone(count) };
    }
    return next;
};

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

/**
 * Asks for the reset of `key` (a challenge id, or ALL_KEY) rather than making it: writes only the small store of
 * requests, with a count ahead of the one asked for before and of `current`.
 *
 * @param requests - the store of asked-for resets; none where resets are made on the file itself
 * @returns whether it was asked for (false: make the reset on the file)
 */
const askFor = (requests: RawJsonStore | undefined, key: string, current: number): boolean => {
    if (!requests) return false;
    const asked = parseRequests(requests.readRaw());
    requests.writeRaw(JSON.stringify({ ...asked, [key]: nextCount(Math.max(asked[key] ?? 0, current)) }));
    return true;
};

/**
 * Runs `change` under the file's cross-process lock, waited for a moment: `done`, or why nothing ran.
 */
const underLock = (
    acquireLock: ((id: string) => StateLock) | undefined,
    change: () => void,
): 'done' | 'busy' | 'unavailable' => {
    const lock = acquireLock ? acquireWithin(() => acquireLock(FILE_LOCK_ID), FILE_LOCK_WAIT_MS) : NO_LOCK;
    if (lock === 'unavailable') {
        logger
            .withCategory('scenario')
            .error('the app cannot create its lock files in its data folder — scenario state not written', null);
        return 'unavailable';
    }
    if (lock === 'busy') {
        logger.withCategory('scenario').warning('scenario state is locked by another process — nothing written', null);
        return 'busy';
    }
    try {
        change();
        return 'done';
    } finally {
        lock.release();
    }
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
 */
const createStateFile = (store: RawJsonStore, acquireLock?: (id: string) => StateLock, requests?: RawJsonStore) => {
    let lastRaw: string | null | undefined;
    let lastRequests: string | null | undefined;
    let lastParsed: ParsedStateFile | undefined;

    const asRequests = (): RawJsonStore | undefined =>
        runtime.isCapacitor() || runtime.isHeadlessService() ? requests : undefined;

    const read = (): ParsedStateFile => {
        const raw = store.readRaw();
        const asked = asRequests()?.readRaw() ?? null;
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

    /**
     * Resets one challenge: asked for where resets are asked for, else made on the file under its lock (a tombstone
     * that keeps the count). An unreadable file is left as it is: clearing it takes a reset of every challenge.
     */
    const resetOne = (key: string): ResetResult => {
        const view = read();
        if (view.ok && askFor(asRequests(), key, epochOf(view.map, key).gen)) return 'removed';
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
     * Resets every challenge, an unreadable file included (there is nothing in it to lose).
     */
    const resetAll = (): ResetResult => {
        const view = read();
        if (view.ok && askFor(asRequests(), ALL_KEY, countOf(view.map[ALL_KEY]))) return 'removed';
        const ran = underLock(acquireLock, () => {
            const { ok, map } = read();
            write({ [ALL_KEY]: nextCount(ok ? countOf(map[ALL_KEY]) : 0) });
        });
        return ran === 'done' ? 'removed' : ran;
    };

    return { read, mutate, resetOne, resetAll };
};

export { createStateFile, epochOf, isRecord, isTombstone };
export type { Mutation, ResetResult, StateLock };
