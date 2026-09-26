/**
 * Types for the CLI host (src/js/cli/). Type-only: nothing here exists at
 * runtime.
 */

/**
 * A `buildHandlers()` map as the CLI calls it: a `null` IPC event first (left
 * out where the handler ignores it), then the handler's own arguments.
 */
export type NullEventHandlers<H> = {
    [K in keyof H]: H[K] extends (event: any, ...args: infer A) => infer R ? (event?: null, ...args: A) => R : never;
};
