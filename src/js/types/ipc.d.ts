/**
 * The `window.api` surface as a type, derived from the channel manifest and
 * the handler modules' own `buildHandlers()` return types. Type-only: nothing
 * here exists at runtime.
 *
 * Each invoke method takes its handler's arguments minus the leading IPC
 * `event` and resolves to the handler's result, so a renderer call is checked
 * against the handler it reaches. Name parity between the manifest and the
 * handlers stays with tests/ipc/manifest.test.js (skipLibCheck means this
 * file's own internals are not checked).
 */
import type { invokeChannels, aliases, sendMethods, eventMethods } from '../ipc/manifest';

type Handlers = ReturnType<typeof import('../ipc/actions.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/computations.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/currency.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/log.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/misc.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/scenarios.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/settings.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/update.handlers').buildHandlers> &
    ReturnType<typeof import('../ipc/voting.handlers').buildHandlers>;

/** manifest.kebabToCamel at the type level. */
type KebabToCamel<S extends string> = S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
    : S;

/** A handler `(event, ...args) => result` as the renderer calls it. */
type Invoke<F> = F extends (event: never, ...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

type InvokeChannel = (typeof invokeChannels)[number];

export type WindowApi = { [C in InvokeChannel as KebabToCamel<C>]: Invoke<Handlers[C]> } & {
    [M in keyof typeof aliases]: Invoke<Handlers[(typeof aliases)[M]]>;
} & {
    // A fire-and-forget send on Electron; Capacitor's logout is async (it
    // flushes the cleared token before navigating), so callers may await it.
    [M in keyof typeof sendMethods]: () => void | Promise<void>;
} & {
    [M in keyof typeof eventMethods]: (callback: (...args: never[]) => void) => () => void;
};

declare global {
    interface Window {
        api: WindowApi;
    }
}
