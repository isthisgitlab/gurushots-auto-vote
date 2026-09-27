/**
 * Shared ipcMain registration for the handler modules (log, misc, settings,
 * voting, actions, update). Each module exports buildHandlers(deps) →
 * {channel: impl}; this registers every entry.
 *
 * Registration also adds a sender-frame check as defense-in-depth: the app
 * only ever loads its own file:// pages, so any invoke arriving from a
 * non-main frame or a non-file origin is refused. Nothing untrusted can
 * load, so the check never fires in practice — it exists so a future regression
 * that renders remote content doesn't inherit the full IPC surface.
 * Unit tests and the Capacitor bridge call buildHandlers() directly and are
 * unaffected.
 */

import * as logger from '../logger';

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * One handler as registered: `(event, ...args) => result`; `event` is null
 * when the CLI or the Capacitor bridge calls the handler directly. The rest args
 * are `never[]` because this is the heterogeneous registration map: every
 * handler's own parameter list is assignable to it, whatever renderer-supplied
 * argument types it declares.
 */
export type IpcHandler = (event: IpcMainInvokeEvent | null, ...args: never[]) => unknown;

/**
 * Call a registered handler with what the renderer sent. The arguments are
 * untrusted by construction; each handler validates its own at runtime, so the
 * call site does not claim their types.
 * @param impl - the registered handler
 * @param event - the IPC event, or null on a direct call
 * @param args - the renderer's arguments
 */
const invokeHandler = (impl: IpcHandler, event: IpcMainInvokeEvent | null, args: unknown[]): unknown =>
    (impl as (event: IpcMainInvokeEvent | null, ...args: unknown[]) => unknown)(event, ...args);

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

/**
 * @param event - Null/undefined on a
 *   direct (non-Electron) invocation.
 */
const isTrustedSender = (event: IpcMainInvokeEvent | IpcMainEvent | null | undefined): boolean => {
    try {
        // Read senderFrame inside the try: Electron's getter throws when the sending frame
        // has already been disposed (renderer navigated or closed while the message was in
        // flight). Outside the try that propagated as an uncaught exception in the main
        // process — a crash rather than the refusal this function is supposed to fall back to.
        const frame = event?.senderFrame;
        // Direct invocation without an Electron event (tests, internal reuse).
        if (!frame) return true;
        if (event?.sender?.mainFrame && frame !== event.sender.mainFrame) return false;
        return typeof frame.url !== 'string' || frame.url.startsWith('file://');
    } catch {
        return false;
    }
};

const registerHandlers = (ipcMain: IpcMain, handlers: Record<string, IpcHandler>) => {
    for (const [channel, impl] of Object.entries(handlers)) {
        ipcMain.handle(channel, (event, ...args: unknown[]) => {
            if (!isTrustedSender(event)) {
                logger
                    .withCategory('api')
                    .warning(
                        `Refused IPC '${channel}' from untrusted frame ${event?.senderFrame?.url ?? '<unknown>'}`,
                        null,
                    );
                return { success: false, error: 'Refused: untrusted sender' };
            }
            return invokeHandler(impl, event, args);
        });
    }
};

// isTrustedSender is exported so the handful of channels registered with ipcMain.on
// (which carries no return value, so it cannot go through registerHandlers) can apply the
// same origin check instead of silently having none.
export { registerHandlers, invokeHandler, isTrustedSender };
