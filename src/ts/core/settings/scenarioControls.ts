/**
 * The ordinary control inbox (`scenarioControls.json` / `gs_scenario_controls`): the typed requests a remote client sends
 * to change a scenario assignment, a definition, a pool or another scenario-affecting setting, and what became of each. It
 * stores requests and acknowledgments only; progress and spend markers stay in the scenario ledger.
 *
 *   - A request is persisted as `pending` before anything is applied, and its final result is recorded after. A repeated
 *     request with the same identity answers what is recorded; the same identity with other arguments is a `conflict`.
 *   - One pending request per target and Stop epoch. A request of an older Stop epoch, or of an earlier run of the app that
 *     never recorded its result, no longer holds the slot: it is kept as `superseded` / `interrupted`, never dropped.
 *   - Each applied change advances the target's revision. Compaction drops the oldest recorded results only, never a pending
 *     request and never a target's latest revision, so a request that expected an older revision cannot apply again after
 *     its result was removed (`stale`).
 *   - The inbox is bounded (`CONTROLS_MAX_BYTES`, twice the scenario import size, so one maximum document and its metadata
 *     fit). A request that would not fit is refused (`full`, `too-large`); nothing pending is dropped to make room.
 *   - Full user Stop never uses this inbox (it has its own priority cell, scenarioLifecycle.ts).
 *   - An inbox that cannot be read or does not have exactly this shape is `unreadable`: nothing is written over it, and a
 *     status read answers `unknown`, never "not received".
 *
 * No argument text is ever returned by a status read.
 */

import { isPlainObject } from '../plainObject';
import { platform } from '../platform/port';
import { SCENARIO_CAPS } from '../scenarios/vocabulary';
import { createJsonStore } from './storage';

const CONTROLS_KEY = 'gs_scenario_controls';
/** Twice the scenario import size: one maximum-sized document plus the bounded control metadata fits. */
const CONTROLS_MAX_BYTES = 2 * SCENARIO_CAPS.importBytes;
/** The longest argument text one pending request carries. */
const CONTROL_PAYLOAD_MAX_BYTES = SCENARIO_CAPS.importBytes;
const MAX_TARGETS = 256;
const MAX_RESULTS = 8;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_PATTERN = /^[A-Za-z0-9@:._-]{1,64}$/;
const MAX_ERROR = 120;

// `shared`: the Android service writes this key too. `strict`: a request the native bridge did not persist is not accepted.
const controlsStore = createJsonStore({
    fileName: 'scenarioControls.json',
    prefKey: CONTROLS_KEY,
    atomic: true,
    strict: true,
    shared: true,
});

/** When this run of the app began: a pending request older than this never recorded its result in this run. */
const RUN_STARTED_AT = Date.now();

type ControlPending = {
    requestId: string;
    operation: string;
    digest: string;
    /** The Stop epoch it was accepted under; null where the fence could not be read. */
    stopEpoch: number | null;
    at: number;
    /** The request's arguments as JSON text, for the executor that applies it. */
    args: string;
};

type ControlFinal = 'applied' | 'failed' | 'superseded' | 'interrupted';

type ControlResult = {
    requestId: string;
    operation: string;
    digest: string;
    status: ControlFinal;
    error: string | null;
    /** The target's revision after this request. */
    revision: number;
    at: number;
};

type ControlTarget = { revision: number; pending: ControlPending | null; results: ControlResult[] };

type ControlInbox = { targets: Record<string, ControlTarget> };

const FINAL_STATUSES: readonly string[] = ['applied', 'failed', 'superseded', 'interrupted'];

const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const PENDING_KEYS = ['requestId', 'operation', 'digest', 'stopEpoch', 'at', 'args'];
const RESULT_KEYS = ['requestId', 'operation', 'digest', 'status', 'error', 'revision', 'at'];
const TARGET_KEYS = ['revision', 'pending', 'results'];

const parsePending = (value: unknown): ControlPending | null => {
    if (!isPlainObject(value) || !hasOnly(value, PENDING_KEYS)) return null;
    const { requestId, operation, digest, stopEpoch, at, args } = value;
    if (
        !isText(requestId, ID_PATTERN) ||
        !isText(operation, NAME_PATTERN) ||
        !isText(digest, NAME_PATTERN) ||
        !(stopEpoch === null || isCount(stopEpoch)) ||
        !isCount(at) ||
        typeof args !== 'string' ||
        bytesOf(args) > CONTROL_PAYLOAD_MAX_BYTES
    ) {
        return null;
    }
    return { requestId, operation, digest, stopEpoch, at, args };
};

const parseResult = (value: unknown): ControlResult | null => {
    if (!isPlainObject(value) || !hasOnly(value, RESULT_KEYS)) return null;
    const { requestId, operation, digest, status, error, revision, at } = value;
    if (
        !isText(requestId, ID_PATTERN) ||
        !isText(operation, NAME_PATTERN) ||
        !isText(digest, NAME_PATTERN) ||
        typeof status !== 'string' ||
        !FINAL_STATUSES.includes(status) ||
        !(error === null || (typeof error === 'string' && error.length <= MAX_ERROR)) ||
        !isCount(revision) ||
        !isCount(at)
    ) {
        return null;
    }
    return { requestId, operation, digest, status: status as ControlFinal, error, revision, at };
};

const parseTarget = (value: unknown): ControlTarget | null => {
    if (!isPlainObject(value) || !hasOnly(value, TARGET_KEYS)) return null;
    const { revision, pending, results } = value;
    if (!isCount(revision) || !Array.isArray(results) || results.length > MAX_RESULTS) return null;
    const parsedPending = pending === null ? null : parsePending(pending);
    if (pending !== null && parsedPending === null) return null;
    const parsedResults = results.map(parseResult);
    if (parsedResults.some((result) => result === null)) return null;
    return { revision, pending: parsedPending, results: parsedResults as ControlResult[] };
};

/** The inbox a text holds: exactly the shape and within the bounds, or null. */
const parseInbox = (raw: string): ControlInbox | null => {
    if (bytesOf(raw) > CONTROLS_MAX_BYTES) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isPlainObject(value) || !hasOnly(value, ['targets']) || !isPlainObject(value.targets)) return null;
    const entries = Object.entries(value.targets);
    if (entries.length > MAX_TARGETS) return null;
    const targets: Record<string, ControlTarget> = Object.create(null) as Record<string, ControlTarget>;
    for (const [name, entry] of entries) {
        const parsed = parseTarget(entry);
        if (!isText(name, NAME_PATTERN) || parsed === null) return null;
        targets[name] = parsed;
    }
    return { targets };
};

type InboxRead = { state: 'ok'; inbox: ControlInbox } | { state: 'unreadable' };

const readInboxText = (raw: string | null): InboxRead => {
    if (raw === null) return { state: 'ok', inbox: { targets: Object.create(null) as Record<string, ControlTarget> } };
    const inbox = parseInbox(raw);
    return inbox === null ? { state: 'unreadable' } : { state: 'ok', inbox };
};

/** The inbox as stored; a store that is not loaded or cannot be read is `unreadable`, never an empty inbox. */
const readInbox = (): InboxRead => {
    try {
        const raw = controlsStore.readRaw();
        if (!platform().storage.loaded(CONTROLS_KEY)) return { state: 'unreadable' };
        return readInboxText(raw);
    } catch {
        return { state: 'unreadable' };
    }
};

/** A 53-bit hash of the request's operation, target and argument text, in hex: two requests of one identity are the same request only when it matches. */
const digestOf = (operation: string, target: string, args: string): string => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    const text = `${operation}\n${target}\n${args}`;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

/** Drops the oldest recorded result; false when there is none. A pending request and a revision are never touched. */
const dropOldestResult = (inbox: ControlInbox): boolean => {
    let oldest: { target: ControlTarget; index: number; at: number } | null = null;
    for (const target of Object.values(inbox.targets)) {
        target.results.forEach((result, index) => {
            if (oldest === null || result.at < oldest.at) oldest = { target, index, at: result.at };
        });
    }
    const found = oldest as { target: ControlTarget; index: number } | null;
    if (found === null) return false;
    found.target.results.splice(found.index, 1);
    return true;
};

/** Compaction: recorded results are dropped, oldest first, until the inbox fits. Returns its size. */
const compactToFit = (inbox: ControlInbox): number => {
    let size = bytesOf(JSON.stringify(inbox));
    while (size > CONTROLS_MAX_BYTES && dropOldestResult(inbox)) size = bytesOf(JSON.stringify(inbox));
    return size;
};

type Located = { target: string; pending: ControlPending } | { target: string; result: ControlResult };

const locate = (inbox: ControlInbox, requestId: string): Located | null => {
    for (const [target, entry] of Object.entries(inbox.targets)) {
        if (entry.pending?.requestId === requestId) return { target, pending: entry.pending };
        const result = entry.results.find((item) => item.requestId === requestId);
        if (result) return { target, result };
    }
    return null;
};

/** What a pending request is now: still pending, superseded by a Stop, or never finished by an earlier run. */
const pendingStatus = (pending: ControlPending, epoch: number | null): 'pending' | 'superseded' | 'interrupted' => {
    if (pending.stopEpoch !== epoch) return 'superseded';
    return pending.at < RUN_STARTED_AT ? 'interrupted' : 'pending';
};

const pushResult = (entry: ControlTarget, result: ControlResult): void => {
    entry.results.push(result);
    while (entry.results.length > MAX_RESULTS) entry.results.shift();
};

type ControlRequestStatus = 'pending' | ControlFinal;

type BeginInput = {
    requestId: string;
    operation: string;
    target: string;
    /** The arguments as JSON text. */
    args: string;
    /** The target revision the client last saw, when it knows one. */
    expectedRevision?: number;
    stopEpoch: number | null;
    at: number;
};

type BeginRefusal = 'invalid' | 'too-large' | 'conflict' | 'stale' | 'busy' | 'full' | 'unreadable' | 'not-saved';

type BeginOutcome =
    | { ok: true; outcome: 'accepted'; revision: number }
    | { ok: true; outcome: 'duplicate'; status: ControlRequestStatus; revision: number; error: string | null }
    | { ok: false; reason: BeginRefusal };

/** Persists a request as pending, or answers what is already recorded for its identity. Applies nothing. */
const beginControlRequest = async (input: BeginInput): Promise<BeginOutcome> => {
    const { requestId, operation, target, args, expectedRevision, stopEpoch, at } = input;
    if (!isText(requestId, ID_PATTERN) || !isText(operation, NAME_PATTERN) || !isText(target, NAME_PATTERN)) {
        return { ok: false, reason: 'invalid' };
    }
    if (bytesOf(args) > CONTROL_PAYLOAD_MAX_BYTES) return { ok: false, reason: 'too-large' };
    const digest = digestOf(operation, target, args);
    const out: { value: BeginOutcome } = { value: { ok: false, reason: 'not-saved' } };
    const saved = await controlsStore
        .updateThrough((current) => {
            const read = readInboxText(current);
            if (read.state === 'unreadable') {
                out.value = { ok: false, reason: 'unreadable' };
                return null;
            }
            const { inbox } = read;
            const found = locate(inbox, requestId);
            if (found !== null) {
                const record = 'pending' in found ? found.pending : found.result;
                if (found.target !== target || record.operation !== operation || record.digest !== digest) {
                    out.value = { ok: false, reason: 'conflict' };
                    return null;
                }
                out.value =
                    'pending' in found
                        ? {
                              ok: true,
                              outcome: 'duplicate',
                              status: pendingStatus(found.pending, stopEpoch),
                              revision: inbox.targets[found.target].revision,
                              error: null,
                          }
                        : {
                              ok: true,
                              outcome: 'duplicate',
                              status: found.result.status,
                              revision: found.result.revision,
                              error: found.result.error,
                          };
                return null;
            }
            const known = Object.hasOwn(inbox.targets, target);
            if (!known && Object.keys(inbox.targets).length >= MAX_TARGETS) {
                out.value = { ok: false, reason: 'full' };
                return null;
            }
            const entry: ControlTarget = known ? inbox.targets[target] : { revision: 0, pending: null, results: [] };
            if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
                out.value = { ok: false, reason: 'stale' };
                return null;
            }
            if (entry.pending !== null) {
                const holding = pendingStatus(entry.pending, stopEpoch);
                if (holding === 'pending') {
                    out.value = { ok: false, reason: 'busy' };
                    return null;
                }
                // It no longer holds the slot, and it is not forgotten: its record stays, as what became of it.
                pushResult(entry, {
                    requestId: entry.pending.requestId,
                    operation: entry.pending.operation,
                    digest: entry.pending.digest,
                    status: holding,
                    error: null,
                    revision: entry.revision,
                    at: entry.pending.at,
                });
            }
            entry.pending = { requestId, operation, digest, stopEpoch, at, args };
            inbox.targets[target] = entry;
            if (compactToFit(inbox) > CONTROLS_MAX_BYTES) {
                out.value = { ok: false, reason: 'full' };
                return null;
            }
            out.value = { ok: true, outcome: 'accepted', revision: entry.revision };
            return JSON.stringify(inbox);
        })
        .catch(() => 'failed' as const);
    return saved === 'failed' ? { ok: false, reason: 'not-saved' } : out.value;
};

type FinishInput = { requestId: string; target: string; ok: boolean; error: string | null; at: number };

type FinishOutcome =
    | { ok: true; status: ControlFinal; revision: number }
    | { ok: false; reason: 'invalid' | 'unreadable' | 'not-pending' | 'not-saved' };

/** Records the final result of a pending request; an applied one advances the target's revision. Repeating it answers the recorded result. */
const finishControlRequest = async (input: FinishInput): Promise<FinishOutcome> => {
    const { requestId, target, ok, error, at } = input;
    if (!isText(requestId, ID_PATTERN) || !isText(target, NAME_PATTERN)) return { ok: false, reason: 'invalid' };
    const out: { value: FinishOutcome } = { value: { ok: false, reason: 'not-saved' } };
    const saved = await controlsStore
        .updateThrough((current) => {
            const read = readInboxText(current);
            if (read.state === 'unreadable') {
                out.value = { ok: false, reason: 'unreadable' };
                return null;
            }
            const entry = Object.hasOwn(read.inbox.targets, target) ? read.inbox.targets[target] : undefined;
            const recorded = entry?.results.find((item) => item.requestId === requestId);
            if (recorded) {
                out.value = { ok: true, status: recorded.status, revision: recorded.revision };
                return null;
            }
            if (!entry || entry.pending?.requestId !== requestId) {
                out.value = { ok: false, reason: 'not-pending' };
                return null;
            }
            const { pending } = entry;
            const revision = ok ? entry.revision + 1 : entry.revision;
            entry.revision = revision;
            entry.pending = null;
            const status: ControlFinal = ok ? 'applied' : 'failed';
            pushResult(entry, {
                requestId,
                operation: pending.operation,
                digest: pending.digest,
                status,
                error: ok || error === null ? null : error.slice(0, MAX_ERROR),
                revision,
                at,
            });
            // The pending request's arguments are gone from the inbox now, so what is left always fits; compaction only trims results.
            compactToFit(read.inbox);
            out.value = { ok: true, status, revision };
            return JSON.stringify(read.inbox);
        })
        .catch(() => 'failed' as const);
    return saved === 'failed' ? { ok: false, reason: 'not-saved' } : out.value;
};

/** One request as a client may see it: never its arguments. */
type ControlRecordView = {
    requestId: string;
    operation: string;
    target: string;
    status: ControlRequestStatus | 'interrupted';
    error: string | null;
    revision: number;
    at: number;
};

type ControlStatusQuery = { requestId: string } | { target: string };

type ControlStatusRead =
    | { state: 'unknown' }
    | { state: 'not-recorded' }
    | { state: 'request'; record: ControlRecordView }
    | {
          state: 'target';
          target: string;
          revision: number;
          pending: ControlRecordView | null;
          results: ControlRecordView[];
      };

const viewOfPending = (
    target: string,
    entry: ControlTarget,
    pending: ControlPending,
    epoch: number | null,
): ControlRecordView => ({
    requestId: pending.requestId,
    operation: pending.operation,
    target,
    status: pendingStatus(pending, epoch),
    error: null,
    revision: entry.revision,
    at: pending.at,
});

const viewOfResult = (target: string, result: ControlResult): ControlRecordView => ({
    requestId: result.requestId,
    operation: result.operation,
    target,
    status: result.status,
    error: result.error,
    revision: result.revision,
    at: result.at,
});

/** Where a request or a target stands, for a client that lost its connection. An inbox that cannot be read is `unknown`. */
const readControlStatus = (query: ControlStatusQuery, epoch: number | null): ControlStatusRead => {
    const read = readInbox();
    if (read.state === 'unreadable') return { state: 'unknown' };
    const { inbox } = read;
    if ('requestId' in query) {
        const found = locate(inbox, query.requestId);
        if (found === null) return { state: 'not-recorded' };
        return {
            state: 'request',
            record:
                'pending' in found
                    ? viewOfPending(found.target, inbox.targets[found.target], found.pending, epoch)
                    : viewOfResult(found.target, found.result),
        };
    }
    const entry = Object.hasOwn(inbox.targets, query.target) ? inbox.targets[query.target] : undefined;
    return {
        state: 'target',
        target: query.target,
        revision: entry?.revision ?? 0,
        pending: entry?.pending ? viewOfPending(query.target, entry, entry.pending, epoch) : null,
        results: (entry?.results ?? []).map((result) => viewOfResult(query.target, result)),
    };
};

const initializeScenarioControlsAsync = (): Promise<void> => controlsStore.initializeAsync();
const flushScenarioControlsWrites = (): Promise<void> => controlsStore.flushPendingWrites();

export {
    CONTROLS_KEY,
    CONTROLS_MAX_BYTES,
    CONTROL_PAYLOAD_MAX_BYTES,
    ID_PATTERN as CONTROL_ID_PATTERN,
    NAME_PATTERN as CONTROL_NAME_PATTERN,
    MAX_ERROR as CONTROL_MAX_ERROR,
    beginControlRequest,
    finishControlRequest,
    readControlStatus,
    initializeScenarioControlsAsync,
    flushScenarioControlsWrites,
};
export type { ControlStatusQuery };
