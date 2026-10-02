/**
 * Runtime check for a challenge or image id received over IPC: the renderer
 * and CLI send a non-blank string or a finite number, a compromised window can
 * send anything.
 */
const isIdArg = (value: unknown): value is string | number =>
    (typeof value === 'string' && value.trim() !== '') || Number.isFinite(value);

export { isIdArg };
