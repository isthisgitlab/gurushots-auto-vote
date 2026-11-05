/**
 * The remote dispatch: what happens to one invoke message a paired phone sent. It refuses
 * unclassified and refused channels (with the allowlist's reason), refuses the
 * `autovoteRunning` key on every write path whatever the running state is (start and stop go
 * through `autovote-command`, so a phone can never flip the auto-resume flag by hand), strips
 * the user-data path
 * out of `get-environment-info`'s answer, and only then hands the call to the injected
 * invoke (the desktop host's `window.api`).
 *
 * Pure and injected, so tests run it without a bridge. Dependency-free.
 */

import { AUTOVOTE_RUNNING_KEY, KEYED_WRITE_CHANNELS, classifyRemoteChannel } from './allowlist';

/** One window.api-backed invoke the dispatch forwards to. */
export type RemoteInvoke = (channel: string, args: unknown[]) => Promise<unknown>;

export type RemoteDispatchDeps = {
    /** The desktop's window.api, as untyped callables (the renderer arguments are the handler's own concern). */
    invoke: RemoteInvoke;
};

export type RemoteDispatchResult = { kind: 'refused'; error: string } | { kind: 'result'; result: unknown };

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
    const result = await deps.invoke(channel, args);
    return { kind: 'result', result: channel === 'get-environment-info' ? withoutUserDataPath(result) : result };
};
