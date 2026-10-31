/**
 * The one id rule, shared by the active-challenge boundary (challengeIntegrity)
 * and the IPC id check (ipc/isIdArg): a value carries a challenge or entry
 * identity only when both callers accept it. Dependency-free.
 *
 * A valid id is a positive safe integer, or a token that starts with a letter
 * or digit and then holds letters, digits, underscores or dashes — 64
 * characters at most. The first-character class already rejects '-1', '_',
 * '@all' and '__proto__'; the reserved words are rejected whole. No trimming
 * happens, so a string with surrounding spaces is not an id, and a string of
 * only zeros is not one either.
 */

const ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ALL_ZEROS_RE = /^0+$/;
// Words every JavaScript object chain answers to, plus the JSON null — never
// an id, so no payload can collide with them.
const RESERVED_ID_STRINGS = ['undefined', 'null', 'constructor', 'prototype'];

const isValidId = (value: unknown): value is string | number => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
    if (typeof value !== 'string') return false;
    if (!ID_TOKEN_RE.test(value) || ALL_ZEROS_RE.test(value)) return false;
    return !RESERVED_ID_STRINGS.includes(value);
};

export { isValidId };
