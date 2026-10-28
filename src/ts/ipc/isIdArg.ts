import { isValidId } from '../ids';

/**
 * Longest id string an IPC handler accepts. Real challenge ids are numeric and
 * image ids 32-character hex; the cap only bounds what a compromised renderer
 * or the CLI can push into logs, lock keys and API paths. The id rule itself
 * (ids.ts) caps tokens at 64 characters through its own pattern; this cap
 * stays for the CLI's truncation of user-typed ids.
 */
const MAX_IPC_ID_LENGTH = 64;

/**
 * Runtime check for a challenge or image id received over IPC: the renderer
 * and CLI send a value ids.ts accepts — a positive safe integer, or a token
 * of at most 64 characters that starts with a letter or digit — a compromised
 * window can send anything. 0, negatives, fractions, unsafe integers,
 * whitespace, all-zero and reserved strings are rejected.
 */
const isIdArg = (value: unknown): value is string | number => isValidId(value);

/**
 * The failure result for a handler whose id arguments failed isIdArg: the
 * machine code the renderer maps to its own wording. Frozen so one handler
 * cannot alter what every other rejection returns.
 */
const invalidArgs = Object.freeze({ success: false as const, error: 'invalid-args' as const });

export { isIdArg, invalidArgs, MAX_IPC_ID_LENGTH };
