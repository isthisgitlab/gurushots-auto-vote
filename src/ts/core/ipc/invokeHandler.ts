/**
 * The handler contract every shell shares: the handler types and the one place renderer arguments reach a handler.
 * The Electron shell registers handlers with ipcMain (registerHandlers.ts); the CLI, the web shell and the Capacitor
 * bridge call them directly through invokeHandler.
 */

import * as logger from '../logger';

import type { IpcMainInvokeEvent } from 'electron';

/**
 * One handler as registered: `(event, ...args) => result`; `event` is null
 * when the CLI or the Capacitor bridge calls the handler directly. The rest args
 * are `never[]` because this is the heterogeneous registration map: every
 * handler's own parameter list is assignable to it, whatever renderer-supplied
 * argument types it declares.
 */
export type IpcHandler = (event: IpcMainInvokeEvent | null, ...args: never[]) => unknown;

// The channels that read the logs back: recording their replies would copy the logs into the debug log. The `log-*`
// channels, which write renderer entries through the logger, are skipped by name for the same reason — the entry is
// in the debug log once already.
const LOG_READING_CHANNELS = new Set(['get-log-backlog', 'get-log-file', 'get-error-log-file', 'get-api-log-file']);

const isRecordedChannel = (channel: string): boolean =>
    !channel.startsWith('log-') && !LOG_READING_CHANNELS.has(channel);

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    typeof (value as { then?: unknown } | null | undefined)?.then === 'function';

/**
 * Call a registered handler with what the renderer sent. The arguments are
 * untrusted by construction; each handler validates its own at runtime, so the
 * call site does not claim their types.
 *
 * A dirty build records the call, its reply or its failure in the debug log
 * (debugLog.ts); the reply or the throw reaches the caller unchanged, a
 * synchronous throw still synchronous.
 * @param channel - the channel the renderer invoked
 * @param impl - the registered handler
 * @param event - the IPC event, or null on a direct call
 * @param args - the renderer's arguments
 */
const invokeHandler = (
    channel: string,
    impl: IpcHandler,
    event: IpcMainInvokeEvent | null,
    args: unknown[],
): unknown => {
    const call = impl as (event: IpcMainInvokeEvent | null, ...args: unknown[]) => unknown;
    if (!logger.debugLogEnabled() || !isRecordedChannel(channel)) return call(event, ...args);
    logger.writeDebug('ipc-in', channel, { channel, args });
    let result: unknown;
    try {
        result = call(event, ...args);
    } catch (error) {
        logger.writeDebug('ipc-error', channel, { channel, error });
        throw error;
    }
    if (!isThenable(result)) {
        logger.writeDebug('ipc-out', channel, { channel, result });
        return result;
    }
    return Promise.resolve(result).then(
        (value) => {
            logger.writeDebug('ipc-out', channel, { channel, result: value });
            return value;
        },
        (error: unknown) => {
            logger.writeDebug('ipc-error', channel, { channel, error });
            throw error;
        },
    );
};

/**
 * What a handler may resolve to. `{ success?: boolean }` is listed so that,
 * used as a contextual type (`satisfies IpcReplyFn` / `IpcHandlerMap`),
 * a returned `success: true`/`false` keeps its literal type and the renderer
 * can discriminate a result on it; the other members admit plain values.
 */
type IpcReturn = { success?: boolean } | object | string | number | boolean | bigint | symbol | null | undefined;

/**
 * A handler, or a helper producing a handler's reply. `never` parameters
 * accept any declared parameter types, so only the result is constrained.
 */
export type IpcReplyFn = (...args: never[]) => IpcReturn | Promise<IpcReturn>;

export type IpcHandlerMap = Record<string, IpcReplyFn>;

export { invokeHandler };
