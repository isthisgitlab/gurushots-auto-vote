/**
 * Longest id string an IPC handler accepts. Real challenge ids are numeric and
 * image ids 32-character hex; the cap only bounds what a compromised renderer
 * or the CLI can push into logs, lock keys and API paths.
 */
const MAX_IPC_ID_LENGTH = 64;

/**
 * Runtime check for a challenge or image id received over IPC: the renderer
 * and CLI send a non-blank string of at most MAX_IPC_ID_LENGTH characters or
 * a finite number, a compromised window can send anything.
 */
const isIdArg = (value: unknown): value is string | number =>
    (typeof value === 'string' && value.trim() !== '' && value.length <= MAX_IPC_ID_LENGTH) || Number.isFinite(value);

/**
 * The failure result for a handler whose id arguments failed isIdArg: the
 * machine code the renderer maps to its own wording. Frozen so one handler
 * cannot alter what every other rejection returns.
 */
const invalidArgs = Object.freeze({ success: false as const, error: 'invalid-args' as const });

export { isIdArg, invalidArgs, MAX_IPC_ID_LENGTH };
