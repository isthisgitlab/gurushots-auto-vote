/**
 * A value of the wrong type, passed on purpose to exercise a function's runtime
 * guard against input the type system cannot vouch for (IPC arguments, persisted
 * JSON, CLI input, a partial mock). The one sanctioned way a test steps outside
 * the types, so each such call reads as deliberate; the target type is inferred
 * from where the value goes.
 */
export const invalid = <T>(value: unknown): T => value as T;
