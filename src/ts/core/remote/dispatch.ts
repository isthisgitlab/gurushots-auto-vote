/**
 * The remote dispatch: what happens to one invoke message a paired phone sent. It refuses
 * unclassified and refused channels (with the allowlist's reason), refuses the
 * `autovoteRunning` key on every write path whatever the running state is (start and stop go
 * through `autovote-command`, so a phone can never flip the auto-resume flag by hand), strips
 * the user-data path
 * out of `get-environment-info`'s answer, and only then hands the call to the injected
 * invoke (the desktop host's `window.api`). A call that changes a scenario (`scenarioControlTarget`) is refused without a
 * request identity, and otherwise runs through the host's control inbox: accepted and persisted first, applied by the same
 * handler a local caller uses, and its result recorded after — a repeated identity answers the record instead of applying again.
 *
 * Pure and injected, so tests run it without a bridge. Dependency-free.
 */

import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import { AUTOVOTE_RUNNING_KEY, KEYED_WRITE_CHANNELS, classifyRemoteChannel, scenarioControlTarget } from './allowlist';

import type { ControlReport } from './protocol';

/** One window.api-backed invoke the dispatch forwards to. */
export type RemoteInvoke = (channel: string, args: unknown[]) => Promise<unknown>;

export type RemoteDispatchDeps = {
    /** The desktop's window.api, as untyped callables (the renderer arguments are the handler's own concern). */
    invoke: RemoteInvoke;
};

/** What a phone's invoke carries besides its arguments: the identity of a scenario change, and the revision of its target the phone last saw. */
export type RemoteInvokeRequest = { requestId?: string; expectedRevision?: number };

export type RemoteDispatchResult =
    | { kind: 'refused'; error: string }
    | { kind: 'result'; result: unknown; control?: ControlReport };

/** The longest reason the inbox records for a failed change. */
const MAX_RECORDED_ERROR = 120;

/** The prefix every remote refusal carries, so the phone's UI can tell it from a handler error. */
export const REMOTE_REFUSAL_PREFIX = 'Refused remotely';

/** What the host answers an invoke from a phone it has no hello from; the phone then says hello again. */
export const REMOTE_SAY_HELLO_FIRST = `${REMOTE_REFUSAL_PREFIX}: say hello first.`;

/** The answer of `get-environment-info` with the user-data path (it holds the OS username) removed. */
export const withoutUserDataPath = (result: unknown): unknown => {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
    const rest: Record<string, unknown> = { ...result };
    delete rest.userDataPath;
    return rest;
};

/** Whether this write, on this channel with these arguments, may pass at all. */
export const isAllowedWrite = (channel: string, args: unknown[]): true | string => {
    const keyAt = KEYED_WRITE_CHANNELS[channel];
    if (keyAt !== undefined && args[keyAt] === AUTOVOTE_RUNNING_KEY) {
        return 'The auto-vote switch is not a setting — use the Start and Stop controls.';
    }
    if (
        channel === 'save-settings' &&
        args[0] !== null &&
        typeof args[0] === 'object' &&
        AUTOVOTE_RUNNING_KEY in (args[0] as object)
    ) {
        return 'The auto-vote switch is not a setting — use the Start and Stop controls.';
    }
    return true;
};

/** Whether a handler's answer says the change did not land: an explicit `false`, or `{ success: false }`. */
const failedAnswer = (result: unknown): boolean =>
    result === false || (isPlainObject(result) && result.success === false);

const answerError = (result: unknown): string | null =>
    isPlainObject(result) && typeof result.error === 'string' ? result.error.slice(0, MAX_RECORDED_ERROR) : null;

/**
 * One scenario change through the control inbox: `begin` persists it as pending (or answers what is recorded for its
 * identity), the handler applies it, `finish` records the result. A change that is not accepted is answered with the inbox's
 * own reason and the handler is never called.
 */
const runControlled = async (
    channel: string,
    args: unknown[],
    target: string,
    request: Required<Pick<RemoteInvokeRequest, 'requestId'>> & RemoteInvokeRequest,
    deps: RemoteDispatchDeps,
): Promise<RemoteDispatchResult> => {
    const { requestId, expectedRevision } = request;
    const begun = await deps.invoke('begin-scenario-request', [
        {
            requestId,
            operation: channel,
            target,
            args: JSON.stringify(args),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
        },
    ]);
    if (!isPlainObject(begun) || begun.success !== true) {
        // A stale request says where the target stands now: the phone's next change expects that revision.
        const standing =
            isPlainObject(begun) && begun.error === 'stale' && typeof begun.revision === 'number'
                ? { control: { requestId, target, revision: begun.revision } as ControlReport }
                : {};
        return { kind: 'result', result: begun, ...standing };
    }
    if (begun.outcome === 'duplicate') {
        const revision = typeof begun.revision === 'number' ? begun.revision : 0;
        const status = begun.status;
        const recorded =
            status === 'applied'
                ? { success: true, duplicate: true }
                : { success: false, error: status === 'failed' ? (answerError(begun) ?? 'failed') : String(status) };
        return { kind: 'result', result: recorded, control: { requestId, target, revision } };
    }
    let answer: unknown;
    let threw = false;
    try {
        answer = await deps.invoke(channel, args);
    } catch (error) {
        // A handler that throws is a failed change: it is recorded like any other and answered with its report.
        threw = true;
        answer = { success: false, error: (errorMessage(error) ?? 'failed').slice(0, MAX_RECORDED_ERROR) };
    }
    const finished = await deps.invoke('finish-scenario-request', [
        {
            requestId,
            target,
            ok: !threw && !failedAnswer(answer),
            ...(answerError(answer) === null ? {} : { error: answerError(answer) }),
        },
    ]);
    const control: ControlReport | undefined =
        isPlainObject(finished) && finished.success === true && typeof finished.revision === 'number'
            ? { requestId, target, revision: finished.revision }
            : undefined;
    return { kind: 'result', result: answer, ...(control === undefined ? {} : { control }) };
};

/**
 * Run one remote invoke through the allowlist and the per-key rules, then the injected
 * invoke. Answers `refused` without ever calling it, or `result` with what the handler
 * answered (a handler's own failure shapes are the handler's — the dispatch passes them
 * through untouched).
 */
export const dispatchRemoteInvoke = async (
    channel: string,
    args: unknown[],
    deps: RemoteDispatchDeps,
    request: RemoteInvokeRequest = {},
): Promise<RemoteDispatchResult> => {
    const classified = classifyRemoteChannel(channel);
    if (classified.kind === 'refused') {
        return { kind: 'refused', error: `${REMOTE_REFUSAL_PREFIX}: ${classified.reason}` };
    }
    if (classified.kind === 'host') {
        return { kind: 'refused', error: `${REMOTE_REFUSAL_PREFIX}: the host answers this channel itself.` };
    }
    const allowedWrite = isAllowedWrite(channel, args);
    if (allowedWrite !== true) {
        return { kind: 'refused', error: `${REMOTE_REFUSAL_PREFIX}: ${allowedWrite}` };
    }
    const target = scenarioControlTarget(channel, args);
    if (target !== null) {
        if (request.requestId === undefined) {
            return { kind: 'refused', error: `${REMOTE_REFUSAL_PREFIX}: a scenario change needs a request identity.` };
        }
        // A phone never moves the installation to another owner: its assignment goes to the host with the owner-keeping option, which
        // the host checks with the generation in the one change that writes it (anything else the phone sent is dropped).
        const sent =
            channel === 'set-installation-scenario' ? [args[0], args[1], args[2], { keepExecutor: true }] : args;
        return runControlled(channel, sent, target, { ...request, requestId: request.requestId }, deps);
    }
    const result = await deps.invoke(channel, args);
    return { kind: 'result', result: channel === 'get-environment-info' ? withoutUserDataPath(result) : result };
};
