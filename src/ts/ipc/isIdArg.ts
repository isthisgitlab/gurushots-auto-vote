import { MAX_ENTRY_ID_LENGTH } from '../metadata/validation';

/**
 * Runtime check for a challenge or image id received over IPC: the renderer
 * and CLI send a non-blank string of at most MAX_ENTRY_ID_LENGTH characters or
 * a finite number, a compromised window can send anything.
 */
const isIdArg = (value: unknown): value is string | number =>
    (typeof value === 'string' && value.trim() !== '' && value.length <= MAX_ENTRY_ID_LENGTH) || Number.isFinite(value);

/**
 * The failure result for a handler whose id arguments failed isIdArg: the
 * machine code the renderer maps to its own wording.
 */
const invalidArgs = { success: false as const, error: 'invalid-args' };

export { isIdArg, invalidArgs };
