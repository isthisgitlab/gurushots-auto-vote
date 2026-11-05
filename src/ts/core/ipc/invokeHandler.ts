/**
 * The handler contract every shell shares: the handler types and the one place renderer arguments reach a handler.
 * The Electron shell registers handlers with ipcMain (registerHandlers.ts); the CLI, the web shell and the Capacitor
 * bridge call them directly through invokeHandler.
 */

import type { IpcMainInvokeEvent } from 'electron';

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

export { invokeHandler };
