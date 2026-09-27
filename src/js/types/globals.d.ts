/**
 * Array.isArray as a type guard that keeps what is known. The standard library
 * narrows to `any[]`, so a runtime guard on a typed `ReadonlyArray<T>` would
 * erase T; narrowing to `unknown[]` keeps T there and gives untyped input
 * `unknown` elements to check instead of `any`.
 */
interface ArrayConstructor {
    isArray(arg: unknown): arg is unknown[];
}
